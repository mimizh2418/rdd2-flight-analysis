"""Regenerate the small Python IPC fixture used by JavaScript and browser interoperability tests.

Run from the repository root with: uv run --locked tests/fixtures/generate_arrow.py.
"""

import math
from pathlib import Path
import sys

import pyarrow as pa

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from rdd2_simulation.arrow_io import prepare_arrow, write_arrow
from rdd2_simulation.metadata import SCHEMA, signal_catalog
from rdd2_simulation.progress import Progress

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
trace = prepare_arrow(names, columns)
manifest = {
    "schema": SCHEMA,
    "name": "Python Arrow flight",
    "world_frame": "ENU",
    "body_frame": "FLU",
    "quaternion_order": "wxyz",
    "signals": signal_catalog(names),
    "observed": trace.observed,
    "mission": {"waypoints": [[0, 0, 1], [4, 0, 1]]},
    "compiler": {"name": "interoperability fixture"},
}
output = Path(__file__).with_name("python-flight.arrow")
write_arrow(output, trace.table, manifest, Progress(quiet=True))
# Keep the fixture small while exercising event groups split across record batches.
table = pa.ipc.open_file(output).read_all()
with pa.OSFile(str(output), "wb") as stream, pa.ipc.new_file(stream, table.schema) as writer:
    for batch in table.to_batches(max_chunksize=2):
        writer.write_batch(batch)
