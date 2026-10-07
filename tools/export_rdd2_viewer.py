#!/usr/bin/env python3
"""Create a versioned viewer bundle from a CSV or a Rumoca scenario.

Only the public Rumoca Python API is used. CSV repackaging never claims a
compiler/model revision that cannot be established from a supplied receipt.
"""

from __future__ import annotations

import argparse
import csv
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib

SCHEMA = "rdd2-viewer-v1"


# Compile the telemetry contract once, rather than rebuilding it for every result channel.
TELEMETRY_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"(?:time_s|armed|missionPhase|flightMode|imuSamplePeriod_s|estimatorUpdatePeriod_s|thrust_N|"
        r"navigationError_m|controllerEstimatorFeedbackError_m|referenceTrackingError_m)",
        r"(?:position_m|velocity_m_s|euler_rad|geodetic|motorCommand|gpsPositionNoise_m|gpsVelocityNoise_m_s|"
        r"opticalFlowIntegratedNoise_rad|opticalFlowGyroscopeIntegratedNoise_rad|imuAngularVelocityNoise_rad_s|"
        r"imuSpecificForceNoise_m_s2|imuPreintegratedDeltaAngle_rad|imuPreintegratedDeltaVelocity_m_s|"
        r"imuPreintegratedDeltaPosition_m|imuGyroscopeBias_rad_s|imuAccelerometerBias_m_s2|"
        r"mocapPositionNoise_m|mocapAttitudeNoise_rad)\[\d+\]",
        r"plant\.truth\.(?:quaternionWorldBody|accelerationWorldEnu_m_s2|angularVelocityBodyFlu_rad_s)\[\d+\]",
        r"plant\.motorOmega_rad_s\[\d+\]",
        (
            r"(?:referencePositionWorldEnu_m|referenceVelocityWorldEnu_m_s|avionics\.reference\.(?:position|velocity|"
            r"acceleration|jerk|snap))\[\d+\]"
        ),
        (
            r"(?:referenceYaw_rad|avionics\.reference\.(?:valid|complete|sequence|activeSegment|trajectoryTime|"
            r"totalDuration|yaw|yawRate))"
        ),
        (
            r"(?:estimator\.estimate\.(?:valid|timestamp_s|positionWorldEnu_m|velocityWorldEnu_m_s|"
            r"accelerationWorldEnu_m_s2|quaternionWorldBody|eulerRpy_rad|angularVelocityBodyFlu_rad_s|"
            r"angularVelocityWorldEnu_rad_s))\[\d+\]"
        ),
        r"estimator\.estimate\.(?:valid|timestamp_s)",
        r"estimator\.estimate\.rotationWorldBody\[\d+,\d+\]",
        r"estimator\.navigationCovarianceLocal\[\d+,\d+\]",
        (
            r"estimator\.(?:gps\.(?:positionCovarianceWorld_m2|velocityCovarianceWorld_m2_s2)|"
            r"opticalFlow\.(?:integratedLineOfSightCovariance_rad2|integratedGyroscopeCovariance_rad2)|"
            r"mocap\.(?:positionCovarianceWorld_m2|attitudeCovarianceBody_rad2))\[\d+,\d+\]"
        ),
        r"estimator\.(?:gps\.(?:fresh|timestamp_s)|opticalFlow\.(?:fresh|timestamp_s)|mocap\.(?:fresh|timestamp_s))",
        (
            r"estimator\.status\.(?:initialized|predictionAccepted|gpsPositionCorrectionAccepted|"
            r"gpsVelocityCorrectionAccepted|opticalFlowCorrectionAccepted|mocapCorrectionAccepted|anchorSource|"
            r"correctionSource|normalizedInnovationSquared|innovationGateRejected|consecutiveRejectedCorrections|"
            r"covarianceReinitialized)"
        ),
        (
            r"(?:imuAngularVelocityNoiseVariance_rad2_s2|imuSpecificForceNoiseVariance_m2_s4|"
            r"imuGyroscopeBiasIncrementVariance_rad2_s2|imuAccelerometerBiasIncrementVariance_m2_s4)\[\d+\]"
        ),
        (
            r"(?:imuPreintegrationTime_s|opticalFlowGroundDistanceNoise_m|opticalFlowIdealGroundDistance_m|"
            r"opticalFlowSurfaceVisible|estimator\.opticalFlow\.groundDistanceVariance_m2)"
        ),
    )
)


class Progress:
    """Report flushed status on stderr and record completed stage wall times.

    Args:
        quiet: Suppress status messages while still collecting timings.
    Notes:
        Heartbeats report elapsed wall time, not solver progress or an estimated completion percentage.
    """

    def __init__(self, quiet: bool = False):
        """Initialize a reporter with an independent clock and timing registry."""
        self.quiet = quiet
        self.started = time.perf_counter()
        self.timings: dict[str, float] = {}
        self.last_update = self.started

    def message(self, text: str) -> None:
        """Flush one status line to stderr; stdout remains the bundle-path channel."""
        if not self.quiet:
            print(f"[rdd2-export] {text}", file=sys.stderr, flush=True)

    def update(self, text: str, *, force: bool = False) -> None:
        """Emit row/byte progress at most once a second, or immediately when forced."""
        now = time.perf_counter()

        if force or now - self.last_update >= 1:
            self.message(text)
            self.last_update = now

    @contextmanager
    def stage(self, key: str, label: str, *, heartbeat: bool = False):
        """Time a stage and report its outcome, optionally emitting five-second heartbeats.

        Args:
            key: Stable key used in manifest timings.
            label: User-facing description of the work.
            heartbeat: Report activity during blocking model loading or simulation.
        Yields:
            None; the caller performs the stage's work inside the context.
        Raises:
            Any exception from the stage, after reporting failure and stopping its heartbeat.
        """
        started = time.perf_counter()
        self.last_update = started
        self.message(f"{label}...")
        stopped = threading.Event()
        worker = None

        def report_activity():
            """Report elapsed time until the enclosing stage finishes or fails."""
            while not stopped.wait(5):
                self.message(f"{label}: still running ({time.perf_counter() - started:.1f} s elapsed)")

        if heartbeat and not self.quiet:
            worker = threading.Thread(target=report_activity, daemon=True)
            worker.start()

        succeeded = False

        try:
            yield
            succeeded = True
        finally:
            elapsed = time.perf_counter() - started
            stopped.set()

            if worker is not None:
                worker.join()

            self.timings[key] = elapsed
            outcome = "completed" if succeeded else "failed"
            self.message(f"{label}: {outcome} in {elapsed:.2f} s")


class CsvStatistics:
    """Validate one numeric trace and accumulate observations without storing its rows.

    Args:
        headers: Original CSV column names, including exactly one supported time column.
    Raises:
        ValueError: Headers are empty, duplicated, or have an ambiguous/missing time column.
    """

    def __init__(self, headers: list[str]):
        """Validate headers and initialize an event-aware time/statistics accumulator."""
        if not headers or len(set(headers)) != len(headers) or any(not header for header in headers):
            raise ValueError("Missing or duplicate column names")

        candidates = [header for header in headers if header in ("time", "time_s")]

        if not candidates:
            candidates = [header for header in headers if header.endswith(".time_s")]

        if len(candidates) != 1:
            raise ValueError("CSV needs one unambiguous time column")

        self.columns = len(headers)
        self.time_index = headers.index(candidates[0])
        self.rows = self.events = self.nonfinite = 0
        self.first = self.previous = None
        self.min_dt, self.max_dt = math.inf, 0.0

    def add(self, values: list[float]) -> None:
        """Validate one row and count gaps/events, preserving every original timestamp.

        Args:
            values: Numeric cells in header order; non-finite non-time cells remain gaps.
        Raises:
            ValueError: Row width differs, time is non-finite, or time moves backwards.
        """
        if len(values) != self.columns:
            raise ValueError(f"Row {self.rows + 2}: invalid field count")

        timestamp = values[self.time_index]

        if not math.isfinite(timestamp) or self.previous is not None and timestamp < self.previous:
            raise ValueError(f"Row {self.rows + 2}: non-finite or backwards time")

        if self.previous is not None:
            interval = timestamp - self.previous

            # Near-coincident event rows are retained, but do not distort the reported solver cadence.
            if interval <= 8 * sys.float_info.epsilon * max(1, abs(timestamp), abs(self.previous)):
                self.events += 1
            else:
                self.min_dt = min(self.min_dt, interval)
                self.max_dt = max(self.max_dt, interval)

        if self.first is None:
            self.first = timestamp

        self.previous = timestamp
        self.rows += 1
        self.nonfinite += sum(not math.isfinite(value) for value in values)

    def finish(self) -> dict:
        """Return observed row, time, cadence, and gap counts; reject an empty trace."""
        if not self.rows:
            raise ValueError("No samples")

        return {
            "rows": self.rows,
            "start_time_s": self.first,
            "end_time_s": self.previous,
            "event_rows": self.events,
            "min_distinct_dt_s": self.min_dt if math.isfinite(self.min_dt) else None,
            "max_distinct_dt_s": self.max_dt,
            "nonfinite_values": self.nonfinite,
        }


@dataclass(frozen=True)
class TraceSummary:
    """Original headers, validated observations, and the SHA-256 of the exact emitted CSV bytes."""

    names: list[str]
    observed: dict
    csv_sha256: str


class HashingWriter:
    """Adapt csv.writer's text output to a binary stream while hashing its exact UTF-8 bytes."""

    def __init__(self, stream):
        """Attach a writable binary stream and start a fresh SHA-256 digest."""
        self.stream = stream
        self.digest = hashlib.sha256()

    def write(self, text: str) -> int:
        """Write and hash one text fragment, returning its character count like a text stream."""
        payload = text.encode("utf-8")
        self.stream.write(payload)
        self.digest.update(payload)

        return len(text)


def sha256(path: Path) -> str:
    """Hash a file in bounded chunks without retaining the whole trace in memory.

    Args:
        path: Readable file to hash in one-megabyte chunks.
    Returns:
        Lowercase SHA-256 hexadecimal digest.
    Raises:
        OSError: The file cannot be opened or read.
    """

    digest = hashlib.sha256()

    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def scan_csv(path: Path, progress: Progress | None = None) -> tuple[list[str], dict]:
    """Validate numeric CSV rows and report timing, event cadence, and missing-value counts.

    Args:
        path: UTF-8 numeric CSV with one supported time column and consistent row widths.
        progress: Optional reporter for throttled row-count updates.
    Returns:
        (headers, observed), where observed includes raw row/event counts, start/end seconds, distinct sample-period
        bounds in seconds, and the non-finite-cell count.
    Raises:
        ValueError: Headers, field counts, numeric values, or the finite/nondecreasing time axis are invalid.
    Notes:
        Empty cells remain NaN. Near-equal event timestamps do not count toward minimum solver cadence.
    """

    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.reader(stream)
        headers = next(reader, [])

        statistics = CsvStatistics(headers)

        for row in reader:
            if not row:
                continue

            if len(row) != statistics.columns:
                raise ValueError(f"Row {statistics.rows + 2}: invalid field count")

            values = [float(v) if v.strip() else math.nan for v in row]
            statistics.add(values)

            if progress is not None and statistics.rows % 5000 == 0:
                progress.update(f"Validated {statistics.rows:,} rows through t={statistics.previous:.6g} s")

    return headers, statistics.finish()


def copy_and_hash(source: Path, destination: Path, progress: Progress) -> str:
    """Copy an input CSV once and hash those same bytes, including its BOM and original line endings.

    Args:
        source: Original log; never modified.
        destination: Private staging file, not a published bundle file.
        progress: Reporter for byte-based copy progress.
    Returns:
        SHA-256 of the exact copied snapshot; receipt verification must use this digest.
    Raises:
        OSError: Reading or writing fails.
    """
    size = source.stat().st_size
    copied = 0
    digest = hashlib.sha256()

    with source.open("rb") as incoming, destination.open("wb") as outgoing:
        for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
            outgoing.write(chunk)
            digest.update(chunk)
            copied += len(chunk)
            progress.update(f"Copying CSV: {min(100, copied / max(1, size) * 100):.0f}% ({copied / 1024**2:.1f} MiB)")

    return digest.hexdigest()


def write_trace(output: Path, names: list[str], times, arrays, progress: Progress) -> TraceSummary:
    """Write, validate, summarize, and hash generated numeric columns in one pass.

    Args:
        output: Private staging CSV; discarded by the caller on failure.
        names: Selected telemetry names, excluding the time column.
        times: Original simulation timestamps, including event rows.
        arrays: Numeric columns aligned with times, in names order.
        progress: Reporter for row-based write progress.
    Returns:
        Validated metadata and the digest of the emitted UTF-8 CSV bytes.
    Raises:
        ValueError: Columns have inconsistent lengths, headers are invalid, or timestamps are invalid.
    """
    headers = ["time", *names]
    statistics = CsvStatistics(headers)
    rows = len(times)

    if len(arrays) != len(names) or any(len(column) != rows for column in arrays):
        raise ValueError("Simulation columns must have the same length as time")

    with output.open("wb") as stream:
        hashing = HashingWriter(stream)
        writer = csv.writer(hashing)
        writer.writerow(headers)

        for index, timestamp in enumerate(times):
            values = [float(timestamp), *(float(column[index]) for column in arrays)]
            statistics.add(values)
            writer.writerow(values)

            if (index + 1) % 1000 == 0:
                progress.update(f"Writing CSV: {(index + 1) / rows * 100:.0f}% ({index + 1:,}/{rows:,} rows)")

    return TraceSummary(headers, statistics.finish(), hashing.digest.hexdigest())


def signal_catalog(names: list[str]) -> dict:
    """Describe exported channels with inferred units, frames, and interpolation kinds.

    Args:
        names: Original Modelica source headers, including any array indices.
    Returns:
        Metadata by channel name, excluding time/time_s. Units and frames are inferred labels; values are not
        converted.
    """

    def entry(name):
        """Infer one source channel's metadata from its Modelica name.

        Args:
            name: One source channel name.
        Returns:
            Label, unit, frame, interpolation kind, and original source name for that channel.
        """

        # Check more specific suffixes first: angular rates contain the angular-position suffix, for example.
        if "_rad_s" in name:
            unit = "rad/s"
        elif "_rad" in name:
            unit = "rad"
        elif "_m_s2" in name:
            unit = "m/s2"
        elif "_m_s" in name:
            unit = "m/s"
        elif re.search(r"_m(?:\[|$)", name):
            unit = "m"
        elif name.endswith("_s"):
            unit = "s"
        elif name.endswith("_N"):
            unit = "N"
        else:
            unit = ""

        held = any(
            s in name
            for s in (
                "estimator.",
                "avionics.",
                "reference",
                "motorCommand",
                "missionPhase",
                "flightMode",
                "armed",
                "Noise",
                "Bias",
                "Period",
            )
        )

        if any(s in name for s in ("Enu", "World", "position_m", "velocity_m_s")):
            frame = "ENU"
        elif "Body" in name:
            frame = "FLU"
        else:
            frame = ""

        return {
            "label": name,
            "unit": unit,
            "frame": frame,
            "kind": "held" if held else "continuous",
            "source": name,
        }

    return {name: entry(name) for name in names if name not in ("time", "time_s")}


def source_identity(root: Path) -> dict:
    """Hash model inputs and record the checkout revision and working-tree status.

    Args:
        root: Modelica checkout whose model/config/resource inputs are inspected.
    Returns:
        Source SHA-256, optional Git revision, and optional dirty-tree status.
    Notes:
        Includes relative filenames and file digests; excludes generated artifacts and dependencies. Git identity is
        None when unavailable rather than invented.
    """

    digest = hashlib.sha256()
    paths = []
    excluded = {".git", "artifacts", "node_modules"}

    # Prune ignored directory trees before traversal, rather than visiting every generated artifact first.
    for directory, children, filenames in os.walk(root):
        children[:] = [name for name in children if name not in excluded]

        for filename in filenames:
            path = Path(directory) / filename
            relative = path.relative_to(root)

            if filename not in excluded and path.is_file():
                if path.suffix in (".mo", ".toml") or filename == "package.order" or "Resources" in relative.parts:
                    paths.append(path)

    for path in sorted(paths):
        # Include relative names as well as file hashes so renamed inputs change the source identity.
        digest.update(str(path.relative_to(root)).encode())
        digest.update(b"\0")
        digest.update(bytes.fromhex(sha256(path)))

    revision = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], text=True, capture_output=True)
    dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], text=True, capture_output=True)

    return {
        "model_revision": revision.stdout.strip() if revision.returncode == 0 else None,
        "source_sha256": digest.hexdigest(),
        "working_tree_dirty": bool(dirty.stdout) if dirty.returncode == 0 else None,
    }


def selected(name: str) -> bool:
    """Keep the interactive telemetry contract compact, even for full results.

    Args:
        name: Unqualified exported Modelica signal name to test.
    Returns:
        True for a supported telemetry-contract signal; False for time columns and unselected channels.
    Notes:
        Each regular expression must match the whole name, including the expected component/matrix indices.
    """

    if name in ("time", "time_s"):
        return False

    return any(pattern.fullmatch(name) for pattern in TELEMETRY_PATTERNS)


def simulate(
    scenario: Path,
    root: Path,
    output: Path,
    rumoca: str,
    stop_time: float | None,
    progress: Progress,
) -> tuple[dict, TraceSummary]:
    """Validate and simulate with matching Rumoca CLI/Python versions, then export selected signals.

    Args:
        scenario: Scenario TOML passed to the Rumoca public Python API and CLI check.
        root: Modelica checkout used as the CLI working directory and for source identity.
        output: Destination CSV file written with time and selected scalar columns.
        rumoca: CLI executable name or path; must match the installed Python package version.
        stop_time: Optional positive final time in seconds, overriding scenario t_end.
        progress: Reporter shared with bundle packaging to collect separate stage timings.
    Returns:
        (provenance, trace), including compiler identity, solver settings, native runtime metrics when available,
        and validated trace metadata. simulation_wall_time_s measures only the model.simulate call.
    Raises:
        RuntimeError: CLI/Python versions differ or source inputs change during simulation.
        subprocess.CalledProcessError: CLI version/check fails.
    Notes:
        Simulation/API/file errors propagate. Unknown termination is recorded honestly. Generated samples are
        validated while writing; packaging does not reread them. Elapsed-time heartbeats are not solver callbacks.
    """

    with progress.stage("scenario_validation", "Checking Rumoca versions and scenario"):
        version = subprocess.run([rumoca, "--version"], check=True, capture_output=True, text=True).stdout.strip()
        subprocess.run(
            [rumoca, "sim", "check", "-c", str(scenario)], cwd=root, check=True, capture_output=True, text=True
        )

        import rumoca as rum

        python_version = importlib.metadata.version("rumoca")

        if python_version not in version:
            raise RuntimeError(f"CLI/Python version mismatch: {version!r} vs {python_version!r}")

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

    with progress.stage("csv_write", "Writing and validating generated CSV"):
        trace = write_trace(output, names, times, arrays, progress)

    with progress.stage("source_identity_after", "Verifying model inputs are unchanged"):
        identity_after = source_identity(root)

        # The recorded model digest must describe the same inputs before and after the simulation.
        if identity_before["source_sha256"] != identity_after["source_sha256"]:
            raise RuntimeError("Model inputs changed during simulation; refusing misleading provenance")

    binary = Path(shutil.which(rumoca) or rumoca).resolve()

    with progress.stage("compiler_hash", "Fingerprinting the Rumoca executable"):
        binary_hash = sha256(binary)

    return {
        **identity_before,
        "model": config_source.get("model", {}).get("name"),
        "scenario": scenario.name,
        "compiler": {
            "name": "Rumoca",
            "cli_version": version,
            "python_version": python_version,
            "binary_sha256": binary_hash,
            "python_module": str(Path(rum.__file__).resolve()),
        },
        "solver": {**config_source.get("sim", {}), "t_end": duration},
        "termination": termination,
        "simulation_wall_time_s": progress.timings["simulation"],
        **({"rumoca_metrics": metrics} if metrics is not None else {}),
    }, trace


def export_bundle(args) -> Path:
    """Create a trace/manifest bundle, verify supplied provenance, and refuse to overwrite results.

    Args:
        args: Namespace from parser(), with exactly one of csv/scenario and an output directory.
    Returns:
        Resolved output directory containing trace.csv and manifest.json.
    Raises:
        ValueError: Options conflict, output is nonempty, scenario is outside the checkout, receipt hash differs, or
        the source CSV is invalid.
    Notes:
        Stages on the output filesystem so publication uses renames instead of another full CSV copy. Generated
        CSV metadata is collected during writing. Imported CSVs are copied/hashed once, then validated as a stable
        snapshot. Existing results are never overwritten; failures discard the staging files.
    """

    if args.csv and args.stop_time is not None:
        raise ValueError("--stop-time only applies when running a scenario")

    if args.receipt and not args.csv:
        raise ValueError("--receipt only applies when repackaging an existing CSV")

    progress = Progress(quiet=getattr(args, "quiet", False))
    out = args.out.resolve()

    if out.exists() and any(out.iterdir()):
        raise ValueError("Output directory must be empty (existing artifacts will not be overwritten)")

    out.mkdir(parents=True, exist_ok=True)

    # A sibling staging directory shares the output filesystem, including when /tmp is on another mount.
    with tempfile.TemporaryDirectory(prefix=f".{out.name}-export-", dir=out.parent) as temporary:
        csv_path = Path(temporary) / "trace.csv"
        provenance: dict = {}

        if args.csv:
            source = args.csv.resolve()
            receipt = json.loads(args.receipt.read_text()) if args.receipt else None
            progress.message(f"Input CSV: {source}")

            with progress.stage("csv_copy", "Copying and fingerprinting input CSV"):
                digest = copy_and_hash(source, csv_path, progress)

            if receipt is not None:
                if receipt.get("csv_sha256") != digest:
                    raise ValueError("Receipt SHA-256 does not match input CSV")

                provenance = {
                    k: receipt[k] for k in ("compiler", "model", "model_revision", "termination") if k in receipt
                }
                provenance["original_receipt"] = receipt
            else:
                # A plain CSV cannot establish which compiler or model revision produced it.
                provenance = {"provenance_status": "unverified input CSV", "termination": "unknown"}

            with progress.stage("csv_validation", "Validating imported CSV"):
                names, observed = scan_csv(csv_path, progress)

            trace = TraceSummary(names, observed, digest)
        else:
            root = args.modelica_root.resolve()
            scenario = args.scenario.resolve()

            if not scenario.is_relative_to(root):
                raise ValueError("Scenario must be inside the supplied modelica_models checkout")

            provenance, trace = simulate(scenario, root, csv_path, args.rumoca, args.stop_time, progress)

        manifest = {
            "schema": SCHEMA,
            "name": args.name or (args.csv.stem if args.csv else args.scenario.stem),
            "csv": "trace.csv",
            "csv_sha256": trace.csv_sha256,
            "world_frame": "ENU",
            "body_frame": "FLU",
            "quaternion_order": "wxyz",
            "observed": trace.observed,
            "signals": signal_catalog(trace.names),
            **provenance,
            "timings_wall_time_s": dict(progress.timings),
        }

        if args.mission_json:
            manifest["mission"] = json.loads(args.mission_json.read_text())
            manifest["mission_metadata_sha256"] = sha256(args.mission_json)

        if args.scenario:
            manifest["scenario_path"] = str(args.scenario.resolve())

        requested = manifest.get("solver", {}).get("t_end")

        if requested is not None and trace.observed["end_time_s"] < requested - 1e-8:
            manifest["coverage_status"] = "partial"
            progress.message(
                f"Partial flight: reached {trace.observed['end_time_s']:g} s of the requested {requested:g} s."
            )

        with progress.stage("publication", "Writing manifest and publishing bundle"):
            staged_manifest = Path(temporary) / "manifest.json"
            staged_manifest.write_text(json.dumps(manifest, indent=2, default=str) + "\n", encoding="utf-8")

            # Check again after a potentially long simulation, before publishing either completed file.
            if any(out.iterdir()):
                raise ValueError("Output directory must be empty (existing artifacts will not be overwritten)")

            csv_path.rename(out / "trace.csv")
            staged_manifest.rename(out / "manifest.json")

    observed = trace.observed
    size = (out / "trace.csv").stat().st_size / 1024**2
    elapsed = time.perf_counter() - progress.started
    progress.message(
        f"Bundle ready: {observed['rows']:,} rows, {len(trace.names) - 1:,} signals, "
        f"{observed['start_time_s']:g}–{observed['end_time_s']:g} s, {size:.1f} MiB. Total: {elapsed:.2f} s."
    )

    return out


def parser():
    """Build the CLI for scenario simulation or existing-CSV repackaging.

    Returns:
        ArgumentParser defining mutually exclusive CSV/scenario input, output/provenance options, and simulator
        settings. It does not parse arguments or start a simulation.
    """

    p = argparse.ArgumentParser(description=__doc__)
    source = p.add_mutually_exclusive_group(required=True)

    source.add_argument("--csv", type=Path, help="Repackage an existing trace without simulating")
    source.add_argument("--scenario", type=Path, help="Run this Rumoca scenario")
    p.add_argument("--modelica-root", type=Path, default=Path("../modelica_models"))
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--rumoca", default=os.environ.get("MODELICA_MODELS_RUMOCA", "rumoca"))
    p.add_argument("--receipt", type=Path, help="Optional existing CSV provenance receipt")
    p.add_argument("--mission-json", type=Path, help="Resolved mission waypoints/trajectory/origin/rotor geometry")
    p.add_argument("--name")
    p.add_argument("--stop-time", type=float)
    p.add_argument(
        "--quiet", action="store_true", help="Suppress progress on stderr; stdout still prints the bundle path"
    )

    return p


if __name__ == "__main__":
    try:
        arguments = parser().parse_args()

        if arguments.stop_time is not None and (not math.isfinite(arguments.stop_time) or arguments.stop_time <= 0):
            raise ValueError("--stop-time must be finite and positive")

        print(export_bundle(arguments))
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError):
            details = error.stderr or error.stdout

            if details:
                print(details.rstrip(), file=sys.stderr)

        print(f"Export failed: {error}", file=sys.stderr)
        sys.exit(1)
