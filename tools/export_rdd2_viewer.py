#!/usr/bin/env python3
"""Command-line entry point and compatibility exports for the modular RDD2 exporter.

Implementation lives in tools/rdd2_exporter; Arrow is the default and --format csv
produces the legacy trace.csv/manifest.json bundle.
Run with uv run --locked tools/export_rdd2_viewer.py; add --extra simulation to uv for scenario exports.
"""

from rdd2_exporter.arrow_io import arrow_modules, prepare_arrow, write_arrow
from rdd2_exporter.bundle import export_bundle
from rdd2_exporter.cli import main, parser
from rdd2_exporter.csv_io import copy_and_hash, scan_csv, write_trace
from rdd2_exporter.metadata import SCHEMA, selected, signal_catalog
from rdd2_exporter.progress import Progress
from rdd2_exporter.provenance import sha256, source_identity
from rdd2_exporter.simulation import simulate
from rdd2_exporter.trace import CsvStatistics, TraceSummary

if __name__ == "__main__":
    raise SystemExit(main())
