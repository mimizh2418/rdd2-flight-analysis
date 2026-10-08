"""Stage validated exports and publish Arrow files or legacy CSV bundles."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import time

from .arrow_io import arrow_modules, csv_to_arrow, write_arrow
from .csv_io import copy_and_hash, scan_csv
from .metadata import SCHEMA, signal_catalog
from .progress import Progress
from .provenance import sha256
from .simulation import simulate
from .trace import TraceSummary


def export_bundle(args) -> Path:
    """Create a trace/manifest bundle, verify supplied provenance, and refuse to overwrite results.

    Args:
        args: Namespace from parser(), with exactly one of csv/scenario and an output directory.
    Returns:
        Resolved output directory containing trace.arrow, or trace.csv and manifest.json.
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

    output_format = args.format
    if output_format == "arrow":
        arrow_modules()  # Fail before starting an expensive simulation when dependencies are missing.
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
            if output_format == "arrow":
                with progress.stage("arrow_conversion", "Converting CSV columns to Arrow"):
                    trace = TraceSummary(names, observed, "", csv_to_arrow(csv_path, names))
                provenance["source_csv_sha256"] = digest
        else:
            root = args.modelica_root.resolve()
            scenario = args.scenario.resolve()

            if not scenario.is_relative_to(root):
                raise ValueError("Scenario must be inside the supplied modelica_models checkout")

            provenance, trace = simulate(scenario, root, csv_path, args.rumoca, args.stop_time, progress, output_format)

        manifest = {
            "schema": SCHEMA,
            "name": args.name or (args.csv.stem if args.csv else args.scenario.stem),
            **({"csv": "trace.csv", "csv_sha256": trace.csv_sha256} if output_format == "csv" else {}),
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

        artifact = Path(temporary) / ("trace.arrow" if output_format == "arrow" else "trace.csv")
        if output_format == "arrow":
            with progress.stage("arrow_write", "Writing Arrow with embedded metadata"):
                write_arrow(artifact, trace.table, manifest, progress)

        with progress.stage("publication", "Publishing completed export"):
            staged_manifest = Path(temporary) / "manifest.json"
            if output_format == "csv":
                staged_manifest.write_text(json.dumps(manifest, indent=2, default=str) + "\n", encoding="utf-8")

            # Check again after a potentially long simulation, before publishing either completed file.
            if any(out.iterdir()):
                raise ValueError("Output directory must be empty (existing artifacts will not be overwritten)")

            artifact.rename(out / artifact.name)
            if output_format == "csv":
                staged_manifest.rename(out / "manifest.json")

    observed = trace.observed
    size = (out / artifact.name).stat().st_size / 1024**2
    elapsed = time.perf_counter() - progress.started
    progress.message(
        f"Bundle ready: {observed['rows']:,} rows, {len(trace.names) - 1:,} signals, "
        f"{observed['start_time_s']:g}–{observed['end_time_s']:g} s, {size:.1f} MiB. Total: {elapsed:.2f} s."
    )

    return out
