"""Export Arrow (default) or a CSV/manifest bundle from a CSV or Rumoca scenario."""

from __future__ import annotations

import argparse
import math
import os
from pathlib import Path
import subprocess
import sys

from .bundle import export_bundle


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
    p.add_argument("--format", choices=("arrow", "csv"), default="arrow", help="Output encoding (default: arrow)")
    p.add_argument("--rumoca", default=os.environ.get("MODELICA_MODELS_RUMOCA", "rumoca"))
    p.add_argument("--receipt", type=Path, help="Optional existing CSV provenance receipt")
    p.add_argument("--mission-json", type=Path, help="Resolved mission waypoints/trajectory/origin/rotor geometry")
    p.add_argument("--name")
    p.add_argument("--stop-time", type=float)
    p.add_argument(
        "--quiet", action="store_true", help="Suppress progress on stderr; stdout still prints the bundle path"
    )

    return p


def main(argv: list[str] | None = None) -> int:
    """Run the exporter CLI, returning an exit status and keeping diagnostics on stderr.

    Args:
        argv: Optional arguments without the executable name; None reads process arguments.
    Returns:
        Zero for a completed export, or one after reporting an export error.
    """
    try:
        arguments = parser().parse_args(argv)
        if arguments.stop_time is not None and (not math.isfinite(arguments.stop_time) or arguments.stop_time <= 0):
            raise ValueError("--stop-time must be finite and positive")
        print(export_bundle(arguments))
        return 0
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError):
            details = error.stderr or error.stdout
            if details:
                print(details.rstrip(), file=sys.stderr)
        print(f"Export failed: {error}", file=sys.stderr)
        return 1
