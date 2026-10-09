"""Run RDD2 simulations and record Arrow logs; convert existing CSV logs as a secondary operation."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from .paths import default_modelica_root
from .progress import report_error
from .worker import ExportCancelled, supervise_export


def parser():
    """Build the simulation-first CLI, with a separate CSV-conversion command.

    Returns:
        ArgumentParser whose run command accepts a scenario and simulation settings, and whose convert-csv
        command accepts an existing log and optional receipt. Both commands default to Arrow output; only
        conversion requires an explicit output directory.
    """

    p = argparse.ArgumentParser(
        description="RDD2 Flight Tools — simulate flight scenarios and export viewer-ready telemetry.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  npm run simulate -- scenarios/rumoca-scenario.circles-mocap.toml\n"
            "  npm run convert:csv -- flight.csv --out exports/flight\n\n"
            "Status goes to stderr. A successful command prints its output directory on stdout."
        ),
    )
    p.set_defaults(csv=None, scenario=None, modelica_root=None, receipt=None, stop_time=None)
    commands = p.add_subparsers(dest="command", required=True, title="commands", metavar="{run,convert-csv}")

    run = commands.add_parser(
        "run",
        help="Run an RDD2 scenario and write an Arrow log",
        description="Simulate RDD2 with the Rumoca Python compiler.",
    )
    run.add_argument(
        "scenario",
        type=Path,
        metavar="SCENARIO",
        help="Rumoca scenario TOML anywhere; absolute, working-directory-relative, or library-relative path",
    )
    simulation_options = run.add_argument_group("simulation settings")
    simulation_options.add_argument(
        "--modelica-root",
        type=Path,
        metavar="PATH",
        default=default_modelica_root(),
        help="Model sources (default: RDD2_MODELICA_ROOT or ../modelica_models)",
    )
    simulation_options.add_argument(
        "--stop-time", type=float, metavar="SECONDS", help="Override the scenario's final simulation time"
    )

    conversion = commands.add_parser(
        "convert-csv",
        help="Convert an existing CSV log without simulating",
        description="Convert legacy CSV telemetry to Arrow.",
    )
    conversion.add_argument("csv", type=Path, metavar="CSV", help="Existing numeric CSV log")
    conversion.add_argument(
        "--receipt", type=Path, metavar="PATH", help="Existing CSV provenance receipt to verify and preserve"
    )

    for command in (run, conversion):
        export_options = command.add_argument_group("export settings")
        export_options.add_argument(
            "--out",
            type=Path,
            metavar="PATH",
            required=command is conversion,
            help="Output directory; replaces generated artifacts"
            + (" (default: exports/<scenario-name>)" if command is run else ""),
        )
        export_options.add_argument(
            "--format",
            choices=("arrow", "csv"),
            default="arrow",
            help="Output format: arrow (default) or CSV with a manifest",
        )
        export_options.add_argument(
            "--mission-json",
            type=Path,
            metavar="PATH",
            help="Resolved mission waypoints/trajectory/origin/rotor geometry",
        )
        export_options.add_argument("--name", help="Log name displayed in the viewer")
        terminal_options = command.add_argument_group("terminal output")
        terminal_options.add_argument(
            "--quiet", action="store_true", help="Suppress progress; stdout still prints the output directory"
        )
        terminal_options.add_argument(
            "--color",
            choices=("auto", "always", "never"),
            default="auto",
            help="Color mode (default: auto; honors NO_COLOR)",
        )

    return p


def main(argv: list[str] | None = None) -> int:
    """Run a simulation or CSV conversion, keeping progress and failures on stderr.

    Args:
        argv: Optional arguments without the executable name; None reads process arguments.
    Returns:
        Zero for a completed export, one for an export error, or 130 for cancellation.
    """
    arguments = parser().parse_args(argv)

    try:
        if arguments.stop_time is not None and (not math.isfinite(arguments.stop_time) or arguments.stop_time <= 0):
            raise ValueError("--stop-time must be finite and positive")
        supervise_export(arguments)
        return 0
    except (KeyboardInterrupt, ExportCancelled):
        report_error("Export cancelled", color=arguments.color, cancelled=True)
        return 130
    except Exception as error:
        operation = "Simulation" if arguments.command == "run" else "CSV conversion"
        report_error(f"{operation} failed: {error}", color=arguments.color)
        return 1
