"""Check invalid input and failed publication without running a solver."""

from contextlib import chdir
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from exporter_support import bundle, exporter


class RollbackTests(unittest.TestCase):
    def test_invalid_simulation_inputs_create_no_output(self):
        """Reject a missing scenario or model library before creating exports or loading Rumoca."""
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            root = Path(directory)
            arguments = exporter.parser().parse_args(
                ["run", "missing.toml", "--modelica-root", str(root), "--format", "csv", "--quiet"]
            )
            for model_root, message in (
                (root, "Scenario must be an existing file"),
                (root / "missing", "Modelica root must be an existing directory"),
            ):
                with self.subTest(model_root=model_root):
                    arguments.modelica_root = model_root
                    with (
                        patch.object(bundle, "simulate", side_effect=AssertionError("Runtime must not be loaded")),
                        self.assertRaisesRegex(ValueError, message),
                    ):
                        exporter.export_bundle(arguments)

                    self.assertEqual(list(root.iterdir()), [])

    def test_partial_publication_restores_artifacts_and_preserves_unrelated_files(self):
        """Restore the old trace, metadata, and alternate format when installing the new manifest fails."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n0,5\n1,6\n")
            output = root / "bundle"
            output.mkdir()
            original = {
                "trace.csv": b"old CSV",
                "manifest.json": b"old metadata",
                "trace.arrow": b"old Arrow",
                "notes": b"keep",
            }
            for name, content in original.items():
                (output / name).write_bytes(content)
            arguments = exporter.parser().parse_args(
                ["convert-csv", str(source), "--format", "csv", "--out", str(output), "--quiet"]
            )
            replace = Path.replace

            def fail_manifest(path, target):
                """Fail the new manifest's installation while allowing backup restoration."""
                if path.name == "manifest.json" and path.parent.name != "previous" and Path(target).parent == output:
                    raise OSError("manifest installation failed")
                return replace(path, target)

            with patch.object(Path, "replace", fail_manifest), self.assertRaisesRegex(OSError, "installation failed"):
                exporter.export_bundle(arguments)

            self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, original)
            self.assertEqual(list(root.glob(".bundle-export-*")), [])

    def test_publication_failure_removes_new_destination_and_all_new_parents(self):
        """Undo a partially installed new bundle, including its nested directory structure."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n0,1\n")
            output = root / "exports" / "nested" / "bundle"
            arguments = exporter.parser().parse_args(
                ["convert-csv", str(source), "--format", "csv", "--out", str(output), "--quiet"]
            )
            replace = Path.replace

            def fail_manifest(path, target):
                """Allow the trace to be installed, then fail the manifest rename."""
                if path.name == "manifest.json" and Path(target).parent == output:
                    raise PermissionError("cannot publish manifest")
                return replace(path, target)

            with patch.object(Path, "replace", fail_manifest), self.assertRaises(PermissionError):
                exporter.export_bundle(arguments)

            self.assertEqual({path.name for path in root.iterdir()}, {"input.csv"})
