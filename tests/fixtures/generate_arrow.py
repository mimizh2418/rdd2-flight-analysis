"""Regenerate the small Python IPC fixture used by JavaScript and browser interoperability tests.

Run from the repository root with: uv run --locked tests/fixtures/generate_arrow.py.
"""

import importlib.util
import math
from pathlib import Path
import sys

import pyarrow as pa

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
SPEC = importlib.util.spec_from_file_location("fixture_exporter", ROOT / "tools/export_rdd2_viewer.py")
exporter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = exporter
SPEC.loader.exec_module(exporter)

names = ["time", "x_m", "y_m", "z_m", "roll_rad", "pitch_rad", "yaw_rad"]
columns = [
    [0, 1, 1, math.nextafter(1, math.inf), 2],
    [-0.0, 1, 2, 3, 4],
    [0, 0, 0, math.nan, 0],
    [1] * 5,
    [0] * 5,
    [0] * 5,
    [0, 0, 0, 0.5, 1],
]
trace = exporter.prepare_arrow(names, columns)
manifest = {
    "schema": "rdd2-viewer-v1",
    "name": "Python Arrow flight",
    "world_frame": "ENU",
    "body_frame": "FLU",
    "quaternion_order": "wxyz",
    "signals": exporter.signal_catalog(names),
    "observed": trace.observed,
    "mission": {"waypoints": [[0, 0, 1], [4, 0, 1]]},
    "compiler": {"name": "interoperability fixture"},
}
output = Path(__file__).with_name("python-flight.arrow")
exporter.write_arrow(output, trace.table, manifest, exporter.Progress(quiet=True))
# Keep the fixture small while exercising event groups split across record batches.
table = pa.ipc.open_file(output).read_all()
with pa.OSFile(str(output), "wb") as stream, pa.ipc.new_file(stream, table.schema) as writer:
    for batch in table.to_batches(max_chunksize=2):
        writer.write_batch(batch)
