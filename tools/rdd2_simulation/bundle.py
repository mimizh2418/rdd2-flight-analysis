"""Stage validated exports and publish Arrow files or legacy CSV bundles."""

from __future__ import annotations

import json
from pathlib import Path
import time

from .arrow_io import arrow_modules, csv_to_arrow, write_arrow
from .csv_io import copy_and_hash, scan_csv
from .metadata import SCHEMA, signal_catalog
from .output import ExportTransaction
from .paths import resolve_scenario
from .progress import Progress, format_bytes
from .provenance import sha256
from .simulation import simulate
from .trace import TraceSummary


def output_directory(args) -> Path:
    """Resolve --out or exports/<scenario-name> without creating any directories.

    Args:
        args: Parsed simulation or CSV-conversion arguments.
    Returns:
        Absolute output directory; default names omit the rumoca-scenario prefix and its separator.
    """
    out = args.out
    if out is None:
        name = args.scenario.stem.removeprefix("rumoca-scenario").lstrip(".-_") or "scenario"
        out = Path("exports") / name
    return out.resolve()


def validate_inputs(args) -> None:
    """Reject conflicting options, missing model roots, and missing inputs before filesystem changes.

    Args:
        args: Parsed simulation or CSV-conversion arguments.
    Raises:
        ValueError: Options conflict or the selected model root/scenario is missing.
        FileNotFoundError: A CSV, receipt, or mission-metadata file is missing.
    """
    if args.csv and args.stop_time is not None:
        raise ValueError("--stop-time only applies when running a scenario")
    if args.receipt and not args.csv:
        raise ValueError("--receipt only applies when repackaging an existing CSV")

    if not args.csv:
        root = args.modelica_root.expanduser().resolve()
        if not root.is_dir():
            raise ValueError(f"Modelica root must be an existing directory: {root}")
        scenario = resolve_scenario(args.scenario, root)
        if not scenario.is_file():
            raise ValueError(f"Scenario must be an existing file: {scenario}")

    for path in (args.csv, args.receipt, args.mission_json):
        if path is not None and not path.is_file():
            raise FileNotFoundError(f"Input must be an existing file: {path}")


def export_bundle(args) -> Path:
    """Create a validated trace/manifest bundle and replace existing generated artifacts.

    Args:
        args: Namespace from parser(), with exactly one of csv/scenario and an optional simulation output directory.
    Returns:
        Resolved output directory containing trace.arrow, or trace.csv and manifest.json.
    Raises:
        ValueError: Options conflict, an artifact path is a directory, scenario is missing, receipt hash differs, or
        the source CSV is invalid.
    Notes:
        Stages on the output filesystem so publication uses renames instead of another full CSV copy. Generated
        CSV metadata is collected during writing. Imported CSVs are copied/hashed once, then validated as a stable
        snapshot. Failures remove staging and newly created empty directories and restore previous artifacts if
        publication started. Successful publication replaces generated artifacts and removes stale format files,
        preserving unrelated files. The CLI supervises native work separately to also clean up after native crashes.
        Without --out, simulations use exports/<scenario-stem> relative to the working directory, removing the
        rumoca-scenario prefix and its separator. A bare rumoca-scenario.toml uses exports/scenario.
    """

    validate_inputs(args)

    output_format = args.format
    if output_format == "arrow":
        arrow_modules()  # Fail before starting an expensive simulation when dependencies are missing.
    progress = Progress(quiet=getattr(args, "quiet", False), color=getattr(args, "color", "auto"))
    out = output_directory(args)
    progress.heading("CSV conversion" if args.csv else "Simulation")
    progress.detail("Output", getattr(args, "display_out", out))
    progress.detail("Format", "Arrow" if output_format == "arrow" else "CSV + manifest")

    # A sibling staging directory shares the output filesystem, including when /tmp is on another mount.
    with ExportTransaction(out) as transaction:
        temporary = transaction.staging
        csv_path = temporary / "trace.csv"
        provenance: dict = {}
        scenario: Path | None = None

        if args.csv:
            source = args.csv.resolve()
            receipt = json.loads(args.receipt.read_text()) if args.receipt else None
            progress.detail("Input", source)

            with progress.stage("csv_copy", "Copy and fingerprint CSV"):
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

            with progress.stage("csv_validation", "Validate CSV"):
                names, observed = scan_csv(csv_path, progress)

            trace = TraceSummary(names, observed, digest)
            if output_format == "arrow":
                with progress.stage("arrow_conversion", "Convert columns to Arrow"):
                    trace = TraceSummary(names, observed, "", csv_to_arrow(csv_path, names))
                provenance["source_csv_sha256"] = digest
        else:
            root = args.modelica_root.expanduser().resolve()
            if not root.is_dir():
                raise ValueError(f"Modelica root must be an existing directory: {root}")

            scenario = resolve_scenario(args.scenario, root)

            if not scenario.is_file():
                raise ValueError(f"Scenario must be an existing file: {scenario}")

            provenance, trace = simulate(scenario, root, csv_path, args.stop_time, progress, output_format)

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

        if scenario is not None:
            # Record the actual compiled source, including library-relative and local project scenarios.
            manifest["scenario_path"] = str(scenario)

        requested = manifest.get("solver", {}).get("t_end")

        if requested is not None and trace.observed["end_time_s"] < requested - 1e-8:
            manifest["coverage_status"] = "partial"
            progress.warning(
                f"Partial flight: reached {trace.observed['end_time_s']:g} s of the requested {requested:g} s."
            )

        artifact = Path(temporary) / ("trace.arrow" if output_format == "arrow" else "trace.csv")
        if output_format == "arrow":
            with progress.stage("arrow_write", "Write Arrow and metadata"):
                write_arrow(artifact, trace.table, manifest, progress)

        with progress.stage("publication", "Publish export"):
            staged_manifest = Path(temporary) / "manifest.json"
            if output_format == "csv":
                staged_manifest.write_text(json.dumps(manifest, indent=2, default=str) + "\n", encoding="utf-8")

            transaction.publish([artifact, staged_manifest] if output_format == "csv" else [artifact])

        observed = trace.observed
        rows = observed["rows"]
        signals = len(trace.names) - 1
        size = (out / artifact.name).stat().st_size
        elapsed = time.perf_counter() - progress.started
        progress.summary(
            "Log ready",
            {
                "Trace": f"{rows:,} row{'s' if rows != 1 else ''} / {signals:,} signal{'s' if signals != 1 else ''}",
                "Time span": f"{observed['start_time_s']:g}–{observed['end_time_s']:g} s",
                "Size": format_bytes(size),
                "Elapsed": f"{elapsed:.2f} s",
            },
        )

    return out
