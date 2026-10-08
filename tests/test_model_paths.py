"""Check Nix model discovery and provenance without requiring a solver or a Nix installation."""

import os
from pathlib import Path
from subprocess import CompletedProcess
import tempfile
import unittest
from unittest.mock import patch

from exporter_support import exporter, provenance


class ModelPathTests(unittest.TestCase):
    def test_environment_default_and_explicit_override(self):
        """Use the pinned library by default while preserving an explicit developer checkout."""
        with patch.dict(os.environ, {"RDD2_MODELICA_ROOT": "/nix/store/pinned-models"}):
            arguments = exporter.parser().parse_args(["run", "flight.toml", "--out", "exports/flight"])
            self.assertEqual(arguments.modelica_root, Path("/nix/store/pinned-models"))

            arguments = exporter.parser().parse_args(
                ["run", "flight.toml", "--out", "exports/flight", "--modelica-root", "local-models"]
            )
            self.assertEqual(arguments.modelica_root, Path("local-models"))

    def test_relative_scenario_reaches_the_selected_library(self):
        """Resolve library-relative paths before simulation without requiring a sibling checkout."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = Path("Vehicles/Rdd2/Test/rumoca-scenario.test.toml")
            scenario = root / relative
            scenario.parent.mkdir(parents=True)
            scenario.write_text('[model]\nname = "RDD2"\n')
            arguments = exporter.parser().parse_args(
                ["run", str(relative), "--modelica-root", str(root), "--out", str(root / "output"), "--format", "csv"]
            )

            with patch("rdd2_simulation.bundle.simulate", side_effect=RuntimeError("reached simulation")) as simulate:
                with self.assertRaisesRegex(RuntimeError, "reached simulation"):
                    exporter.export_bundle(arguments)

            self.assertEqual(simulate.call_args.args[:2], (scenario.resolve(), root.resolve()))

    def test_relative_scenario_cannot_escape_the_library(self):
        """Reject a path traversal before the simulation runtime is loaded."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arguments = exporter.parser().parse_args(
                [
                    "run",
                    "../outside.toml",
                    "--modelica-root",
                    str(root),
                    "--out",
                    str(root / "output"),
                    "--format",
                    "csv",
                ]
            )

            with patch("rdd2_simulation.bundle.simulate") as simulate:
                with self.assertRaisesRegex(ValueError, "Scenario must be inside"):
                    exporter.export_bundle(arguments)

            simulate.assert_not_called()

    def test_pin_is_only_applied_to_the_matching_non_git_source(self):
        """Record the immutable source revision without labeling an unrelated developer tree with the same pin."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pinned = root / "pinned"
            developer = root / "developer"
            pinned.mkdir()
            developer.mkdir()
            (pinned / "Vehicle.mo").write_text("model Vehicle end Vehicle;")
            revision = "ea5c4750b271392d4940e8619751b112f9669ee3"

            with (
                patch.dict(os.environ, {"RDD2_MODELICA_ROOT": str(pinned), "RDD2_MODELICA_REVISION": revision}),
                patch.object(provenance.subprocess, "run", return_value=CompletedProcess([], 128, "", "no repository")),
            ):
                identity = exporter.source_identity(pinned)
                self.assertEqual(identity["model_revision"], revision)
                self.assertIsNone(identity["working_tree_dirty"])
                self.assertNotEqual(identity["source_sha256"], exporter.source_identity(developer)["source_sha256"])
                self.assertIsNone(exporter.source_identity(developer)["model_revision"])

                with patch.object(
                    provenance.subprocess, "run", return_value=CompletedProcess([], 0, "local-revision", "")
                ):
                    self.assertEqual(exporter.source_identity(pinned)["model_revision"], "local-revision")
