"""Verify artifact replacement, format changes, and preservation of previous exports on failure."""

import json
from pathlib import Path
import tempfile
import unittest

import pyarrow as pa

from exporter_support import exporter


class PublicationTests(unittest.TestCase):
    def test_repeated_exports_replace_logs_and_remove_the_previous_format(self):
        """Replace Arrow and CSV data and metadata while preserving unrelated output files."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            output = root / "bundle"
            output.mkdir()
            notes = output / "notes.txt"
            notes.write_text("Keep these notes")

            for index, encoding in enumerate(("csv", "arrow", "arrow", "csv")):
                with self.subTest(format=encoding, run=index):
                    source.write_text(f"time,x\n0,{index}\n1,{index + 1}\n")
                    name = f"Run {index}"
                    arguments = exporter.parser().parse_args(
                        [
                            "convert-csv",
                            str(source),
                            "--out",
                            str(output),
                            "--format",
                            encoding,
                            "--name",
                            name,
                            "--quiet",
                        ]
                    )
                    exporter.export_bundle(arguments)

                    if encoding == "arrow":
                        table = pa.ipc.open_file(output / "trace.arrow").read_all()
                        manifest = json.loads(table.schema.metadata[b"rdd2:manifest"])
                        self.assertEqual(table["x"].to_pylist(), [index, index + 1])
                        expected = {"trace.arrow", "notes.txt"}
                    else:
                        manifest = json.loads((output / "manifest.json").read_text())
                        self.assertEqual((output / "trace.csv").read_bytes(), source.read_bytes())
                        self.assertEqual(manifest["csv_sha256"], exporter.sha256(output / "trace.csv"))
                        expected = {"trace.csv", "manifest.json", "notes.txt"}

                    self.assertEqual(manifest["name"], name)
                    self.assertEqual({path.name for path in output.iterdir()}, expected)
                    self.assertEqual(notes.read_text(), "Keep these notes")

    def test_invalid_input_preserves_the_previous_export(self):
        """Reject invalid telemetry before replacing either the old trace or its metadata."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n1,1\n0,2\n")
            output = root / "bundle"
            output.mkdir()
            existing = {"trace.csv": b"previous log", "manifest.json": b"previous metadata"}
            for name, content in existing.items():
                (output / name).write_bytes(content)
            arguments = exporter.parser().parse_args(["convert-csv", str(source), "--out", str(output), "--quiet"])

            with self.assertRaises(ValueError):
                exporter.export_bundle(arguments)

            self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, existing)
            self.assertEqual(list(root.glob(".bundle-export-*")), [])

    def test_csv_bundle_can_be_converted_in_its_existing_directory(self):
        """Read an existing CSV and receipt completely before replacing them with an Arrow log."""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            source = output / "trace.csv"
            source.write_text("time,x\n0,4\n1,5\n")
            receipt = output / "manifest.json"
            receipt.write_text(json.dumps({"csv_sha256": exporter.sha256(source), "termination": "completed"}))
            arguments = exporter.parser().parse_args(
                ["convert-csv", str(source), "--receipt", str(receipt), "--out", str(output), "--quiet"]
            )

            exporter.export_bundle(arguments)

            table = pa.ipc.open_file(output / "trace.arrow").read_all()
            self.assertEqual(table["x"].to_pylist(), [4, 5])
            self.assertEqual(json.loads(table.schema.metadata[b"rdd2:manifest"])["termination"], "completed")
            self.assertEqual({path.name for path in output.iterdir()}, {"trace.arrow"})

    def test_directories_at_artifact_paths_are_preserved(self):
        """Refuse to replace an artifact directory or remove its contents."""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            source = output / "input.csv"
            source.write_text("time,x\n0,1\n")
            occupied = output / "trace.arrow"
            occupied.mkdir()
            nested = occupied / "notes.txt"
            nested.write_text("Keep this directory")
            arguments = exporter.parser().parse_args(["convert-csv", str(source), "--out", str(output), "--quiet"])

            with self.assertRaisesRegex(ValueError, "Artifact path is a directory"):
                exporter.export_bundle(arguments)

            self.assertEqual(nested.read_text(), "Keep this directory")
