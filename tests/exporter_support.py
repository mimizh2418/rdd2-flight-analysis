"""Expose simulation-tool modules and serialization helpers for Python regression tests."""

from pathlib import Path
import sys
from types import SimpleNamespace

SIMULATOR_PATH = Path(__file__).parents[1] / "tools/rdd2_simulate.py"
sys.path.insert(0, str(SIMULATOR_PATH.parent))

from rdd2_simulation import arrow_io, bundle, cli, csv_io, metadata, progress, provenance, simulation

# Tests import the owning modules directly; the executable only exposes its command-line entry point.
exporter = SimpleNamespace(
    parser=cli.parser,
    export_bundle=bundle.export_bundle,
    prepare_arrow=arrow_io.prepare_arrow,
    write_arrow=arrow_io.write_arrow,
    write_trace=csv_io.write_trace,
    scan_csv=csv_io.scan_csv,
    sha256=provenance.sha256,
    source_identity=provenance.source_identity,
    signal_catalog=metadata.signal_catalog,
    SCHEMA=metadata.SCHEMA,
    Progress=progress.Progress,
)
