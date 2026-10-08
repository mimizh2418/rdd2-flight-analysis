"""Run RDD2 simulations and record Arrow logs; convert existing CSV logs as a secondary operation."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
import sys

from .bundle import export_bundle
from .paths import default_modelica_root


def parser():
    """Build the simulation-first CLI, with a separate CSV-conversion command.

    Returns:
        ArgumentParser whose run command accepts a scenario and simulation settings, and whose convert-csv
        command accepts an existing log and optional receipt. Both commands default to Arrow output.
    """

    p = argparse.ArgumentParser(description=__doc__)
    p.set_defaults(csv=None, scenario=None, modelica_root=None, receipt=None, stop_time=None)
    commands = p.add_subparsers(dest="command", required=True)

    run = commands.add_parser(
        "run",
        help="Run an RDD2 scenario and write an Arrow log",
        description="Simulate RDD2 with the Rumoca Python compiler.",
    )
    run.add_argument(
        "scenario",
        type=Path,
        metavar="SCENARIO",
        help="Rumoca scenario TOML path, optionally relative to the model library",
    )
    run.add_argument(
        "--modelica-root",
        type=Path,
        default=default_modelica_root(),
        help="Model sources (default: RDD2_MODELICA_ROOT or ../modelica_models)",
    )
    run.add_argument("--stop-time", type=float, help="Override the scenario's final simulation time in seconds")

    conversion = commands.add_parser(
        "convert-csv",
        help="Convert an existing CSV log without simulating",
        description="Convert legacy CSV telemetry to Arrow.",
    )
    conversion.add_argument("csv", type=Path, metavar="CSV", help="Existing numeric CSV log")
    conversion.add_argument("--receipt", type=Path, help="Existing CSV provenance receipt to verify and preserve")

    for command in (run, conversion):
        command.add_argument(
            "--out", type=Path, required=True, help="Output directory for trace.arrow (or the CSV bundle)"
        )
        command.add_argument(
            "--format",
            choices=("arrow", "csv"),
            default="arrow",
            help="Output format: arrow (default) or CSV with a manifest",
        )
        command.add_argument(
            "--mission-json", type=Path, help="Resolved mission waypoints/trajectory/origin/rotor geometry"
        )
        command.add_argument("--name", help="Log name displayed in the viewer")
        command.add_argument(
            "--quiet", action="store_true", help="Suppress progress; stdout still prints the output directory"
        )

    return p


def main(argv: list[str] | None = None) -> int:
    """Run a simulation or CSV conversion, keeping progress and failures on stderr.

    Args:
        argv: Optional arguments without the executable name; None reads process arguments.
    Returns:
        Zero for a completed export, or one after reporting an export error.
    """
    arguments = parser().parse_args(argv)

    try:
        if arguments.stop_time is not None and (not math.isfinite(arguments.stop_time) or arguments.stop_time <= 0):
            raise ValueError("--stop-time must be finite and positive")
        print(export_bundle(arguments))
        return 0
    except Exception as error:
        operation = "Simulation" if arguments.command == "run" else "CSV conversion"
        print(f"{operation} failed: {error}", file=sys.stderr)
        return 1
