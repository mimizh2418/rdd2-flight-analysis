import json
from pathlib import Path
import tempfile
import unittest

from exporter_support import exporter


class ExportTests(unittest.TestCase):
    def test_bundle_and_digest(self):
        """Check bundle contents, provenance, the trace hash, and overwrite protection.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            csv = root / "input.csv"

            csv.write_text("time_s,x_m,y_m,z_m,roll_rad,pitch_rad,yaw_rad\n0,0,0,1,0,0,0\n1,1,0,1,0,0,0\n")

            args = exporter.parser().parse_args(["--csv", str(csv), "--out", str(root / "bundle"), "--quiet"])
            path = exporter.export_bundle(args)
            manifest = json.loads((path / "manifest.json").read_text())

            self.assertEqual(manifest["csv_sha256"], exporter.sha256(path / "trace.csv"))
            self.assertEqual(manifest["observed"]["rows"], 2)
            self.assertEqual(manifest["provenance_status"], "unverified input CSV")
            self.assertNotIn("model_revision", manifest)

            with self.assertRaises(ValueError):
                exporter.export_bundle(args)

    def test_invalid_receipt(self):
        """Reject a receipt whose hash does not match the source trace.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            csv = root / "input.csv"

            csv.write_text("time,x\n0,1\n")

            receipt = root / "receipt.json"

            receipt.write_text('{"csv_sha256":"bad"}')

            args = exporter.parser().parse_args(
                ["--csv", str(csv), "--receipt", str(receipt), "--out", str(root / "bundle"), "--quiet"]
            )

            with self.assertRaises(ValueError):
                exporter.export_bundle(args)

    def test_near_event_cadence(self):
        """Group near-coincident events without reporting a spurious tiny sample period.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "trace.csv"

            p.write_text("time,x\n0,1\n1,2\n1.0000000000000002,3\n2,4\n")

            _, stats = exporter.scan_csv(p)

            self.assertEqual(stats["event_rows"], 1)
            self.assertAlmostEqual(stats["min_distinct_dt_s"], 1)

    def test_backwards_time_fails(self):
        """Reject traces whose time axis moves backwards.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "trace.csv"

            p.write_text("time,x\n1,1\n0,2\n")

            with self.assertRaises(ValueError):
                exporter.scan_csv(p)


if __name__ == "__main__":
    unittest.main()
