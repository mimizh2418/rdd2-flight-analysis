#!/usr/bin/env python3
"""Create a versioned viewer bundle from a CSV or a Rumoca scenario.

Only the public Rumoca Python API is used. CSV repackaging never claims a
compiler/model revision that cannot be established from a supplied receipt.
"""

from __future__ import annotations
import argparse
import csv
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
import time
import tomllib

SCHEMA = "rdd2-viewer-v1"


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


def scan_csv(path: Path) -> tuple[list[str], dict]:
    """Validate numeric CSV rows and report timing, event cadence, and missing-value counts.

    Args:
        path: UTF-8 numeric CSV with one supported time column and consistent row widths.
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

        if not headers or len(set(headers)) != len(headers) or any(not h for h in headers):
            raise ValueError("Missing or duplicate column names")

        candidates = [h for h in headers if h in ("time", "time_s")]

        if not candidates:
            candidates = [h for h in headers if h.endswith(".time_s")]

        if len(candidates) != 1:
            raise ValueError("CSV needs one unambiguous time column")

        ti = headers.index(candidates[0])
        count = events = invalid = 0
        previous = first = None
        min_dt, max_dt = math.inf, 0.0

        for row in reader:
            if not row:
                continue

            if len(row) != len(headers):
                raise ValueError(f"Row {count + 2}: invalid field count")

            values = [float(v) if v.strip() else math.nan for v in row]
            t = values[ti]

            if len(candidates) > 1 and any(
                not math.isclose(
                    t,
                    values[headers.index(candidate)],
                    rel_tol=8 * sys.float_info.epsilon,
                    abs_tol=8 * sys.float_info.epsilon * max(1.0, abs(t)),
                )
                for candidate in candidates
                if headers.index(candidate) != ti
            ):
                raise ValueError(f"Row {count + 2}: time and time_s columns disagree")

            if not math.isfinite(t) or previous is not None and t < previous:
                raise ValueError(f"Row {count + 2}: non-finite or backwards time")

            if previous is not None:
                dt = t - previous

                # Event-rich traces can have distinct rows only a few ULPs apart; these are not solver cadence.
                if dt <= 8 * sys.float_info.epsilon * max(1, abs(t), abs(previous)):
                    events += 1
                else:
                    min_dt, max_dt = min(min_dt, dt), max(max_dt, dt)

            if first is None:
                first = t

            previous = t
            count += 1
            invalid += sum(not math.isfinite(v) for v in values)

    if not count:
        raise ValueError("No samples")

    return headers, {
        "rows": count,
        "start_time_s": first,
        "end_time_s": previous,
        "event_rows": events,
        "min_distinct_dt_s": min_dt if math.isfinite(min_dt) else None,
        "max_distinct_dt_s": max_dt,
        "nonfinite_values": invalid,
    }


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
    paths = sorted(
        p
        for p in root.rglob("*")
        if p.is_file()
        and (p.suffix in (".mo", ".toml") or p.name == "package.order" or "Resources" in p.relative_to(root).parts)
        and not any(s in p.relative_to(root).parts for s in (".git", "artifacts", "node_modules"))
    )

    for path in paths:
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

    patterns = (
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

    return any(re.fullmatch(pattern, name) for pattern in patterns)


def simulate(scenario: Path, root: Path, output: Path, rumoca: str, stop_time: float | None) -> dict:
    """Validate and simulate with matching Rumoca CLI/Python versions, then export selected signals.

    Args:
        scenario: Scenario TOML passed to the Rumoca public Python API and CLI check.
        root: Modelica checkout used as the CLI working directory and for source identity.
        output: Destination CSV file written with time and selected scalar columns.
        rumoca: CLI executable name or path; must match the installed Python package version.
        stop_time: Optional positive final time in seconds, overriding scenario t_end.
    Returns:
        Provenance with compiler identity, solver settings, source digest, observed termination, and wall time.
    Raises:
        RuntimeError: CLI/Python versions differ or source inputs change during simulation.
        subprocess.CalledProcessError: CLI version/check fails.
    Notes:
        Simulation/API/file errors propagate. Unknown termination is recorded honestly; the caller validates and
        packages the CSV afterward.
    """

    version = subprocess.run([rumoca, "--version"], check=True, capture_output=True, text=True).stdout.strip()

    subprocess.run([rumoca, "sim", "check", "-c", str(scenario)], cwd=root, check=True)

    import rumoca as rum

    python_version = importlib.metadata.version("rumoca")

    if python_version not in version:
        raise RuntimeError(f"CLI/Python version mismatch: {version!r} vs {python_version!r}")

    config_source = tomllib.loads(scenario.read_text())
    duration = stop_time if stop_time is not None else float(config_source.get("sim", {}).get("t_end", 45))
    identity_before = source_identity(root)
    session, model, config = rum.Session.from_scenario(str(scenario))
    started = time.perf_counter()
    result = model.simulate(t=(0.0, duration), config=config)
    names = [name for name in result.names if selected(name)]
    arrays = [result[name] for name in names]

    with output.open("w", newline="") as stream:
        writer = csv.writer(stream)

        writer.writerow(["time", *names])

        for i, sample_time in enumerate(result.time):
            writer.writerow([float(sample_time), *(float(a[i]) for a in arrays)])

    identity_after = source_identity(root)

    # The recorded model digest must describe the same inputs before and after the simulation.
    if identity_before["source_sha256"] != identity_after["source_sha256"]:
        raise RuntimeError("Model inputs changed during simulation; refusing misleading provenance")

    binary = Path(shutil.which(rumoca) or rumoca).resolve()

    return {
        **identity_before,
        "model": config_source.get("model", {}).get("name"),
        "scenario": scenario.name,
        "compiler": {
            "name": "Rumoca",
            "cli_version": version,
            "python_version": python_version,
            "binary_sha256": sha256(binary),
            "python_module": str(Path(rum.__file__).resolve()),
        },
        "solver": {**config_source.get("sim", {}), "t_end": duration},
        "termination": getattr(result, "termination", None) or "unknown",
        "simulation_wall_time_s": time.perf_counter() - started,
    }


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
        Writes simulation output to a temporary directory before packaging. Existing results are never overwritten.
        Repackaged CSVs remain unverified without a matching receipt; other I/O/simulation errors propagate.
    """

    if args.csv and args.stop_time is not None:
        raise ValueError("--stop-time only applies when running a scenario")

    if args.receipt and not args.csv:
        raise ValueError("--receipt only applies when repackaging an existing CSV")

    out = args.out.resolve()

    if out.exists() and any(out.iterdir()):
        raise ValueError("Output directory must be empty (existing artifacts will not be overwritten)")

    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="rdd2-export-") as temporary:
        csv_path = Path(temporary) / "trace.csv"
        provenance: dict = {}

        if args.csv:
            source = args.csv.resolve()

            if args.receipt:
                receipt = json.loads(args.receipt.read_text())

                if receipt.get("csv_sha256") != sha256(source):
                    raise ValueError("Receipt SHA-256 does not match input CSV")

                provenance = {
                    k: receipt[k] for k in ("compiler", "model", "model_revision", "termination") if k in receipt
                }
                provenance["original_receipt"] = receipt
            else:
                # A plain CSV cannot establish which compiler or model revision produced it.
                provenance = {"provenance_status": "unverified input CSV", "termination": "unknown"}

            shutil.copyfile(source, csv_path)
        else:
            root = args.modelica_root.resolve()
            scenario = args.scenario.resolve()

            if not scenario.is_relative_to(root):
                raise ValueError("Scenario must be inside the supplied modelica_models checkout")

            provenance = simulate(scenario, root, csv_path, args.rumoca, args.stop_time)

        names, observed = scan_csv(csv_path)
        manifest = {
            "schema": SCHEMA,
            "name": args.name or (args.csv.stem if args.csv else args.scenario.stem),
            "csv": "trace.csv",
            "csv_sha256": sha256(csv_path),
            "world_frame": "ENU",
            "body_frame": "FLU",
            "quaternion_order": "wxyz",
            "observed": observed,
            "signals": signal_catalog(names),
            **provenance,
        }

        if args.mission_json:
            manifest["mission"] = json.loads(args.mission_json.read_text())
            manifest["mission_metadata_sha256"] = sha256(args.mission_json)

        if args.scenario:
            manifest["scenario_path"] = str(args.scenario.resolve())

        requested = manifest.get("solver", {}).get("t_end")

        if requested is not None and observed["end_time_s"] < requested - 1e-8:
            manifest["coverage_status"] = "partial"

        shutil.copyfile(csv_path, out / "trace.csv")
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str) + "\n")

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

    return p


if __name__ == "__main__":
    try:
        arguments = parser().parse_args()

        if arguments.stop_time is not None and (not math.isfinite(arguments.stop_time) or arguments.stop_time <= 0):
            raise ValueError("--stop-time must be finite and positive")

        print(export_bundle(arguments))
    except Exception as error:
        print(f"Export failed: {error}", file=sys.stderr)
        sys.exit(1)
