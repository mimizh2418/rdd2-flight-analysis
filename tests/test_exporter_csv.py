"""Protect trace fidelity and imported snapshot/receipt behavior."""

import csv
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from exporter_support import exporter, provenance


class CsvTests(unittest.TestCase):
    def test_generated_trace_preserves_events_and_numeric_values(self):
        """Round-trip event timestamps, signed zero, tiny values, and non-finite gaps without rounding."""
        times = [0.0, 1.0, math.nextafter(1.0, math.inf), 2.0]
        values = [-0.0, math.ulp(0.0), math.nan, math.inf]

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "trace.csv"
            summary = exporter.write_trace(output, ["position_m[1]"], times, [values], exporter.Progress(quiet=True))
            names, observed = exporter.scan_csv(output)

            self.assertEqual(summary.names, names)
            self.assertEqual(summary.observed, observed)
            self.assertEqual(summary.csv_sha256, exporter.sha256(output))
            self.assertEqual(observed["event_rows"], 1)
            self.assertEqual(observed["nonfinite_values"], 2)

            with output.open(newline="") as stream:
                rows = list(csv.reader(stream))[1:]

            self.assertEqual([float(row[0]) for row in rows], times)
            self.assertEqual(math.copysign(1, float(rows[0][1])), -1)
            self.assertEqual(float(rows[1][1]), values[1])
            self.assertTrue(math.isnan(float(rows[2][1])))
            self.assertEqual(float(rows[3][1]), math.inf)

    def test_generated_trace_rejects_invalid_columns_or_time(self):
        """Reject malformed generated data just as imported traces are rejected."""
        cases = [
            (["x"], [0.0], [[]]),
            (["x"], [0.0], []),
            (["x", "x"], [0.0], [[1.0], [2.0]]),
            (["time_s"], [0.0], [[0.0]]),
            (["x"], [], [[]]),
            (["x"], [math.nan], [[1.0]]),
            (["x"], [1.0, 0.0], [[1.0, 2.0]]),
        ]

        with tempfile.TemporaryDirectory() as directory:
            for names, times, arrays in cases:
                with self.subTest(names=names, times=times, arrays=arrays), self.assertRaises(ValueError):
                    exporter.write_trace(
                        Path(directory) / "trace.csv", names, times, arrays, exporter.Progress(quiet=True)
                    )

    def test_import_preserves_exact_bytes_and_verified_receipt(self):
        """Keep the BOM, quoted names, line endings, gaps, and receipt hash from the copied snapshot."""
        payload = b'\xef\xbb\xbftime,"covariance[1,2]"\r\n0,\r\n1,2\r\n'

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_bytes(payload)
            receipt = {"csv_sha256": exporter.sha256(source), "model": "RDD2", "termination": "complete"}
            receipt_path = root / "receipt.json"
            receipt_path.write_text(json.dumps(receipt))
            args = exporter.parser().parse_args(
                [
                    "--format",
                    "csv",
                    "--csv",
                    str(source),
                    "--receipt",
                    str(receipt_path),
                    "--out",
                    str(root / "bundle"),
                    "--quiet",
                ]
            )

            # Imported bytes are fingerprinted during the copy, without a second full-file hash read.
            with patch.object(provenance, "sha256", side_effect=AssertionError("Unexpected CSV reread")):
                output = exporter.export_bundle(args)

            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual((output / "trace.csv").read_bytes(), payload)
            self.assertEqual(manifest["csv_sha256"], receipt["csv_sha256"])
            self.assertEqual(manifest["original_receipt"], receipt)
            self.assertEqual(manifest["observed"]["nonfinite_values"], 1)
            self.assertIn("csv_copy", manifest["timings_wall_time_s"])
            self.assertIn("csv_validation", manifest["timings_wall_time_s"])

    def test_failed_import_removes_staging_files(self):
        """Do not publish or leave staged CSVs after a validation failure."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n1,2\n0,3\n")
            args = exporter.parser().parse_args(
                ["--format", "csv", "--csv", str(source), "--out", str(root / "bundle"), "--quiet"]
            )

            with self.assertRaises(ValueError):
                exporter.export_bundle(args)

            self.assertEqual(list((root / "bundle").iterdir()), [])
            self.assertEqual(list(root.glob(".bundle-export-*")), [])
