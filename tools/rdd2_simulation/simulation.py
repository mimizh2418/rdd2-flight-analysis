"""Run the public Rumoca API and retain selected telemetry with verified provenance."""

from __future__ import annotations

import importlib.metadata
from pathlib import Path
import tomllib

from .arrow_io import prepare_arrow
from .csv_io import write_trace
from .metadata import selected
from .progress import Progress
from .provenance import sha256, source_identity
from .trace import TraceSummary


def simulate(
    scenario: Path,
    root: Path,
    output: Path,
    stop_time: float | None,
    progress: Progress,
    output_format: str = "arrow",
) -> tuple[dict, TraceSummary]:
    """Load a scenario with the bundled Rumoca compiler, simulate, and export selected signals.

    Args:
        scenario: Scenario TOML validated and compiled by the Rumoca public Python API.
        root: Modelica checkout used for source identity.
        output: Staging destination used when output_format is csv.
        stop_time: Optional positive final time in seconds, overriding scenario t_end.
        progress: Reporter shared with bundle packaging to collect separate stage timings.
        output_format: arrow retains numeric buffers for later publication; csv writes a staged trace.
    Returns:
        (provenance, trace), including compiler identity, solver settings, native runtime metrics when available,
        and validated trace metadata. simulation_wall_time_s measures only the model.simulate call.
    Raises:
        RuntimeError: Simulation dependencies are missing or source inputs change during simulation.
    Notes:
        Simulation/API/file errors propagate. Unknown termination is recorded honestly. Generated samples are
        validated while writing; packaging does not reread them. Elapsed-time heartbeats are not solver callbacks.
    """

    with progress.stage("runtime_setup", "Loading the Rumoca Python compiler"):
        try:
            import rumoca as rum
        except ImportError as error:
            raise RuntimeError(
                "Scenario simulation requires the simulation extra: "
                "uv run --locked --extra simulation tools/rdd2_simulate.py run SCENARIO --out DIRECTORY; "
                f"Rumoca import failed: {error}"
            ) from error

        python_version = importlib.metadata.version("rumoca")
        native_version = rum.version()
        # Identify the native library actually used by this Python process, rather than another executable.
        native_extension = Path(rum._native.__file__).resolve()

    config_source = tomllib.loads(scenario.read_text())
    duration = stop_time if stop_time is not None else float(config_source.get("sim", {}).get("t_end", 45))
    model_name = config_source.get("model", {}).get("name", "unspecified")
    progress.message(f"Model: {model_name}; scenario: {scenario.name}; Rumoca: {python_version}.")

    with progress.stage("source_identity_before", "Fingerprinting model inputs"):
        identity_before = source_identity(root)

    with progress.stage("model_load", "Loading and compiling the model", heartbeat=True):
        session, model, config = rum.Session.from_scenario(str(scenario))

    solver = config_source.get("sim", {}).get("solver", "auto")
    progress.message(f"Requested flight: 0–{duration:g} s; solver: {solver}.")

    with progress.stage("simulation", "Running Rumoca simulation (runtime setup and integration)", heartbeat=True):
        result = model.simulate(t=(0.0, duration), config=config)

    termination = getattr(result, "termination", None) or "unknown"
    metrics = getattr(result, "metrics", None)

    with progress.stage("channel_extraction", "Extracting viewer telemetry"):
        available = result.names
        names = [name for name in available if selected(name)]
        arrays = [result[name] for name in names]
        times = result.time

    progress.message(f"Selected {len(names):,} of {len(available):,} channels; {len(times):,} simulation rows.")

    # Selected arrays remain owned by Python. Release unused full-result columns before CSV formatting.
    del result

    if output_format == "arrow":
        with progress.stage("arrow_validation", "Validating Arrow columns"):
            trace = prepare_arrow(["time", *names], [times, *arrays])
    else:
        with progress.stage("csv_write", "Writing and validating generated CSV"):
            trace = write_trace(output, names, times, arrays, progress)

    with progress.stage("source_identity_after", "Verifying model inputs are unchanged"):
        identity_after = source_identity(root)

        # The recorded model digest must describe the same inputs before and after the simulation.
        if identity_before["source_sha256"] != identity_after["source_sha256"]:
            raise RuntimeError("Model inputs changed during simulation; refusing misleading provenance")

    with progress.stage("compiler_hash", "Fingerprinting the Rumoca native extension"):
        native_hash = sha256(native_extension)

    return {
        **identity_before,
        "model": config_source.get("model", {}).get("name"),
        "scenario": scenario.name,
        "compiler": {
            "name": "Rumoca",
            "python_version": python_version,
            "native_version": native_version,
            "native_extension": str(native_extension),
            "native_extension_sha256": native_hash,
            "python_module": str(Path(rum.__file__).resolve()),
        },
        "solver": {**config_source.get("sim", {}), "t_end": duration},
        "termination": termination,
        "simulation_wall_time_s": progress.timings["simulation"],
        **({"rumoca_metrics": metrics} if metrics is not None else {}),
    }, trace
