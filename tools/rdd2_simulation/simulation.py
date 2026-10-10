"""Run the public Rumoca API and retain selected telemetry with verified provenance."""

from __future__ import annotations

import importlib.metadata
from pathlib import Path
import re
import shutil
import tempfile
import tomllib

from .arrow_io import prepare_arrow
from .csv_io import write_trace
from .metadata import selected
from .paths import PROJECT_SCENARIOS, model_source_root
from .progress import Progress
from .provenance import sha256, simulation_source_identity
from .trace import TraceSummary


OPTIONAL_CONTROLLER_FEEDFORWARD = {
    "jerkWorld_m_s3": "jerk",
    "snapWorld_m_s4": "snap",
    "yawRate_rad_s": "yaw rate",
    "yawAcceleration_rad_s2": "yaw acceleration",
}
OPTIONAL_CONTROLLER_EQUATION = re.compile(
    r"^([ \t]*)controller\.reference\.("
    + "|".join(OPTIONAL_CONTROLLER_FEEDFORWARD)
    + r")\s*=\s*reference\.\w+\s*;[ \t]*$",
    re.MULTILINE,
)


def controller_feedforward_inputs(rum, root: Path) -> frozenset[str]:
    """Inspect the selected RDD2 controller's actual reference fields without running it."""
    session = rum.Session(roots=[str(root)])
    probe = session.load(str(root / "Vehicles/Rdd2/Controller.mo"), model="Vehicles.Rdd2.Controller")
    variables = probe.to_dict("flat")["variables"]
    return frozenset(field for field in OPTIONAL_CONTROLLER_FEEDFORWARD if f"reference.{field}" in variables)


def omit_unsupported_feedforward(source: str, supported: frozenset[str]) -> str:
    """Omit only project mission equations targeting unavailable optional controller inputs."""
    return OPTIONAL_CONTROLLER_EQUATION.sub(
        lambda match: (
            match[0] if match[2] in supported else f"{match[1]}// Optional controller input {match[2]} is unavailable."
        ),
        source,
    )


def load_scenario(rum, scenario: Path, root: Path, *, progress: Progress | None = None):
    """Compile a scenario from any directory using the selected library and any external models.

    Args:
        rum: Imported Rumoca public API module.
        scenario: Resolved original scenario TOML.
        root: Selected Modelica library directory, including an explicit developer override.
    Returns:
        Rumoca's (session, model, config), retaining all original simulation settings.
    Notes:
        Rumoca 0.10.2 has no root override on from_scenario. A temporary TOML supplies absolute model paths and
        the selected roots, leaving the original TOML and library untouched. Project missions use a temporary
        source copy when the selected controller lacks optional feedforward inputs. Compilation completes before cleanup.
    """
    # Keep CSV conversion and missing-runtime diagnostics usable without installed simulation dependencies.
    import tomli_w

    config = tomllib.loads(scenario.read_text())
    model = config.get("model", {})
    model_file = None
    if "file" in model:
        model_file = (scenario.parent / Path(model["file"]).expanduser()).resolve()
        model["file"] = str(model_file)

    # Nested library packages already belong to root. Registering their directory again as a top-level source
    # root changes the expected `within` namespace (for example, Vehicles.Rdd2.Test becomes just Test).
    roots = [str(root)]
    source = None
    if model_file is not None and not model_file.is_relative_to(root):
        source = model_source_root(model_file)
        roots.append(str(source))
    config["source_roots"] = roots

    with tempfile.TemporaryDirectory(prefix="rdd2-scenario-") as directory:
        if source == PROJECT_SCENARIOS:
            supported = controller_feedforward_inputs(rum, root)
            ignored = set(OPTIONAL_CONTROLLER_FEEDFORWARD) - supported
            if ignored:
                adapted = Path(directory) / source.name
                shutil.copytree(source, adapted)
                for path in adapted.rglob("*.mo"):
                    path.write_text(omit_unsupported_feedforward(path.read_text(), supported), encoding="utf-8")
                model["file"] = str(adapted / model_file.relative_to(source))
                config["source_roots"] = [str(root), str(adapted)]
                if progress is not None:
                    labels = ", ".join(
                        label for field, label in OPTIONAL_CONTROLLER_FEEDFORWARD.items() if field in ignored
                    )
                    progress.detail("Feedforward", "Unsupported controller inputs ignored: " + labels)
        effective_scenario = Path(directory) / scenario.name
        effective_scenario.write_text(tomli_w.dumps(config), encoding="utf-8")
        return rum.Session.from_scenario(str(effective_scenario))


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
        root: Modelica checkout used for compilation and source identity.
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
        validated while writing; packaging does not reread them. The activity indicator is not a solver callback.
    """

    with progress.stage("runtime_setup", "Load Rumoca compiler"):
        try:
            import rumoca as rum
        except ImportError as error:
            raise RuntimeError(
                "Scenario simulation requires the simulation extra: "
                "uv run --locked --extra simulation tools/rdd2_simulate.py run SCENARIO; "
                f"Rumoca import failed: {error}"
            ) from error

        python_version = importlib.metadata.version("rumoca")
        native_version = rum.version()
        # Identify the native library actually used by this Python process, rather than another executable.
        native_extension = Path(rum._native.__file__).resolve()

    config_source = tomllib.loads(scenario.read_text())
    duration = stop_time if stop_time is not None else float(config_source.get("sim", {}).get("t_end", 45))
    model_name = config_source.get("model", {}).get("name", "unspecified")
    progress.detail("Model", model_name)
    progress.detail("Scenario", scenario)
    progress.detail("Compiler", f"Rumoca {python_version}")
    progress.detail("Library", root)

    with progress.stage("source_identity_before", "Fingerprint model inputs"):
        identity_before = simulation_source_identity(root, scenario)

    with progress.stage("model_load", "Compile model"):
        session, model, config = load_scenario(rum, scenario, root, progress=progress)

    solver = config_source.get("sim", {}).get("solver", "auto")
    progress.detail("Flight", f"0–{duration:g} s / solver: {solver}")

    with progress.stage("simulation", "Simulate flight"):
        result = model.simulate(t=(0.0, duration), config=config)

    termination = getattr(result, "termination", None) or "unknown"
    metrics = getattr(result, "metrics", None)

    with progress.stage("channel_extraction", "Extract viewer telemetry"):
        available = result.names
        names = [name for name in available if selected(name)]
        arrays = [result[name] for name in names]
        times = result.time

    progress.detail("Telemetry", f"{len(names):,}/{len(available):,} channels / {len(times):,} rows")

    # Selected arrays remain owned by Python. Release unused full-result columns before CSV formatting.
    del result

    if output_format == "arrow":
        with progress.stage("arrow_validation", "Validate Arrow columns"):
            trace = prepare_arrow(["time", *names], [times, *arrays])
    else:
        with progress.stage("csv_write", "Write and validate CSV"):
            trace = write_trace(output, names, times, arrays, progress)

    with progress.stage("source_identity_after", "Verify model inputs"):
        identity_after = simulation_source_identity(root, scenario)

        # The recorded model digest must describe the same inputs before and after the simulation.
        if identity_before["source_sha256"] != identity_after["source_sha256"]:
            raise RuntimeError("Model inputs changed during simulation; refusing misleading provenance")

    with progress.stage("compiler_hash", "Fingerprint native compiler"):
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
