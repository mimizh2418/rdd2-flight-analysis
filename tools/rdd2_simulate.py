#!/usr/bin/env python3
"""Run RDD2 simulations and record Arrow logs, with optional legacy CSV conversion.

Use uv run --locked --extra simulation tools/rdd2_simulate.py run SCENARIO [--out DIRECTORY].
Use uv run --locked tools/rdd2_simulate.py convert-csv CSV --out DIRECTORY for existing logs.
"""

from rdd2_simulation.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
