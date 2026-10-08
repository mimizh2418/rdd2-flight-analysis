"""Check binary export fidelity, metadata, and CSV conversion without running a solver."""

import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import numpy as np
import pyarrow as pa

from exporter_support import exporter


class ArrowTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "JavaScript interoperability requires Node.js")
    def test_javascript_output_reads_back_in_python(self):
        """Read the viewer's IPC encoder with PyArrow and compare the original Float64 bit patterns."""
        root = Path(__file__).resolve().parents[1]
        if not (root / "node_modules/apache-arrow").is_dir():
            self.skipTest("Install npm dependencies for JavaScript interoperability")
        fixture = root / "tests/fixtures/python-flight.arrow"
        script = """
            import { readFileSync, writeFileSync } from 'node:fs';
            import { compile } from './tools/test.mjs';
            compile();
            const { decodeArrow, encodeArrow } = await import('./.test-build/src/data/arrow.js');
            const { columns, manifest } = decodeArrow(readFileSync(process.argv[1]));
            writeFileSync(process.argv[2], encodeArrow(columns, manifest));
        """
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "javascript.arrow"
            subprocess.run(
                ["node", "--input-type=module", "-e", script, str(fixture), str(output)],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            )
            original = pa.ipc.open_file(fixture).read_all()
            restored = pa.ipc.open_file(output).read_all()
            for name in original.column_names:
                np.testing.assert_array_equal(
                    original[name].to_numpy().view(np.uint64), restored[name].to_numpy().view(np.uint64)
                )
            self.assertEqual(restored.schema.metadata[b"rdd2:format"], original.schema.metadata[b"rdd2:format"])
            self.assertEqual(
                json.loads(restored.schema.metadata[b"rdd2:manifest"]),
                json.loads(original.schema.metadata[b"rdd2:manifest"]),
            )
            for name in original.column_names:
                self.assertEqual(
                    json.loads(restored.schema.field(name).metadata[b"rdd2:signal"]),
                    json.loads(original.schema.field(name).metadata[b"rdd2:signal"]),
                )

    def test_columns_match_csv_statistics_and_preserve_bits(self):
        """Retain event order, signed zero, subnormals and non-finite gaps through multiple IPC batches."""
        times = np.arange(65540, dtype=np.float64)
        times[2] = math.nextafter(1.0, math.inf)
        values = times.copy()
        values[:4] = [-0.0, math.ulp(0.0), math.nan, math.inf]
        progress = exporter.Progress(quiet=True)
        trace = exporter.prepare_arrow(["time", "position_m[1]"], [times, values])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv = exporter.write_trace(root / "trace.csv", ["position_m[1]"], times, [values], progress)
            self.assertEqual(trace.observed, csv.observed)
            manifest = {
                "schema": exporter.SCHEMA,
                "name": "Binary test",
                "observed": trace.observed,
                "signals": {"position_m[1]": {"unit": "m", "frame": "ENU", "kind": "continuous"}},
                "mission": {"waypoints": [[0, 0, 1], [2, 0, 1]]},
            }
            exporter.write_arrow(root / "trace.arrow", trace.table, manifest, progress)
            reader = pa.ipc.open_file(root / "trace.arrow")
            self.assertEqual(reader.num_record_batches, 2)
            restored = reader.read_all()
            np.testing.assert_array_equal(restored["time"].to_numpy(), times)
            np.testing.assert_array_equal(restored["position_m[1]"].to_numpy().view(np.uint64), values.view(np.uint64))
            self.assertEqual(json.loads(restored.schema.metadata[b"rdd2:manifest"]), manifest)

    def test_default_csv_conversion_embeds_metadata_without_sidecar(self):
        """Import legacy blank cells as NaN and retain receipt identity as source provenance."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text('time,"covariance[1,2]"\n0,\n1,nan\n2,inf\n')
            args = exporter.parser().parse_args(["--csv", str(source), "--out", str(root / "out"), "--quiet"])
            output = exporter.export_bundle(args)
            self.assertEqual([file.name for file in output.iterdir()], ["trace.arrow"])
            table = pa.ipc.open_file(output / "trace.arrow").read_all()
            self.assertEqual(table.column(1).null_count, 0)
            self.assertTrue(math.isnan(table.column(1)[0].as_py()))
            self.assertTrue(math.isnan(table.column(1)[1].as_py()))
            self.assertEqual(table.column(1)[2].as_py(), math.inf)
            manifest = json.loads(table.schema.metadata[b"rdd2:manifest"])
            self.assertNotIn("csv_sha256", manifest)
            self.assertEqual(manifest["source_csv_sha256"], exporter.sha256(source))

    def test_invalid_binary_columns_are_rejected(self):
        """Reject backwards, non-finite or empty time and mismatched channel lengths before publication."""
        for columns in ([[1, 0], [1, 2]], [[math.nan], [1]], [[], []], [[0], []]):
            with self.subTest(columns=columns), self.assertRaises(ValueError):
                exporter.prepare_arrow(["time", "x"], columns)
