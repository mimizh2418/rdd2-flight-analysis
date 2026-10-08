"""Validate scenario export, truthful timings, and provenance guards with a public-API Rumoca stub."""

from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from exporter_support import exporter, bundle, progress, simulation


class ResultStub:
    """Expose only the public result properties and column access used by the exporter."""

    names = ["time", "position_m[1]", "internal.unsupported"]
    time = [0.0, 1.0, 1.0000000000000002]
    termination = "completed"
    metrics = {"simulate_seconds": 4.5, "points": 3, "variables": 3}

    def __getitem__(self, name):
        """Return selected numeric samples; fail if an unsupported full-result column is copied."""
        if name != "position_m[1]":
            raise AssertionError(f"Unexpected channel extraction: {name}")

        return [0.0, 2.0, 3.0]


class SimulationTests(unittest.TestCase):
    def test_arrow_simulation_does_not_serialize_csv(self):
        """Write native numeric results straight to IPC, carrying provenance inside the file."""
        import pyarrow as pa

        self.args.format = "arrow"
        with (
            patch.object(simulation, "write_trace", side_effect=AssertionError("No intermediate CSV")),
            patch.object(bundle, "scan_csv", side_effect=AssertionError("No CSV scan")),
        ):
            output = exporter.export_bundle(self.args)
        self.assertEqual([file.name for file in output.iterdir()], ["trace.arrow"])
        table = pa.ipc.open_file(output / "trace.arrow").read_all()
        self.assertEqual(table["time"].to_pylist(), ResultStub.time)
        self.assertEqual(table["position_m[1]"].to_pylist(), [0.0, 2.0, 3.0])
        manifest = json.loads(table.schema.metadata[b"rdd2:manifest"])
        self.assertEqual(manifest["simulation_wall_time_s"], 5.0)
        self.assertEqual(manifest["coverage_status"], "partial")
        self.assertEqual(manifest["compiler"]["python_version"], "0.10.0")

    def setUp(self):
        """Create a scenario and matching fake CLI/Python runtimes, with a deterministic stage clock."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scenario = self.root / "scenario.toml"
        self.scenario.write_text('[model]\nname = "RDD2"\n[sim]\nt_end = 2\nsolver = "auto"\n')
        self.binary = self.root / "rumoca"
        self.binary.write_bytes(b"test compiler")
        self.args = exporter.parser().parse_args(
            [
                "--format",
                "csv",
                "--scenario",
                str(self.scenario),
                "--modelica-root",
                str(self.root),
                "--rumoca",
                str(self.binary),
                "--out",
                str(self.root / "bundle"),
                "--quiet",
            ]
        )
        self.clock = 0.0
        self.model = Mock()
        self.model.simulate.side_effect = self.simulate
        self.session = Mock()
        self.session.from_scenario.return_value = (object(), self.model, {"runtime": "config"})
        runtime = SimpleNamespace(Session=self.session, __file__=str(self.root / "rumoca.py"))
        patches = ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.dict(sys.modules, rumoca=runtime))
        patches.enter_context(patch.object(simulation.importlib.metadata, "version", return_value="0.10.0"))
        patches.enter_context(
            patch.object(simulation.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "rumoca 0.10.0"))
        )
        patches.enter_context(patch.object(progress.time, "perf_counter", side_effect=lambda: self.clock))
        self.identity = patches.enter_context(
            patch.object(simulation, "source_identity", return_value={"source_sha256": "unchanged"})
        )

    def simulate(self, **kwargs):
        """Represent five seconds spent in native simulation, independently of all export work."""
        self.clock += 5.0

        return ResultStub()

    def test_generated_bundle_avoids_rescan_and_reports_separate_timings(self):
        """Package generated data directly, preserving native metrics and excluding CSV work from solver timing."""
        original_write = exporter.write_trace
        original_hash = exporter.sha256

        def slow_write(*args):
            """Represent twenty seconds of export work without making the regression test sleep."""
            self.clock += 20.0

            return original_write(*args)

        def compiler_hash_only(path):
            """Allow provenance hashing, but reject a redundant generated-CSV hash read."""
            self.assertEqual(path, self.binary)

            return original_hash(path)

        with (
            patch.object(simulation, "write_trace", side_effect=slow_write),
            patch.object(bundle, "scan_csv", side_effect=AssertionError("Generated CSV must not be rescanned")),
            patch.object(simulation, "sha256", side_effect=compiler_hash_only),
        ):
            output = exporter.export_bundle(self.args)

        manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual(manifest["simulation_wall_time_s"], 5.0)
        self.assertEqual(manifest["timings_wall_time_s"]["csv_write"], 20.0)
        self.assertIn("model_load", manifest["timings_wall_time_s"])
        self.assertEqual(manifest["rumoca_metrics"], ResultStub.metrics)
        self.assertEqual(manifest["csv_sha256"], original_hash(output / "trace.csv"))
        self.assertEqual(manifest["observed"], exporter.scan_csv(output / "trace.csv")[1])
        self.assertEqual(list(manifest["signals"]), ["position_m[1]"])
        self.assertEqual(manifest["coverage_status"], "partial")
        self.model.simulate.assert_called_once_with(t=(0.0, 2.0), config={"runtime": "config"})

    def test_changed_model_inputs_prevent_publication(self):
        """Keep the before/after provenance guard even though generated CSVs are no longer reread."""
        self.identity.side_effect = [{"source_sha256": "before"}, {"source_sha256": "after"}]

        with self.assertRaisesRegex(RuntimeError, "Model inputs changed"):
            exporter.export_bundle(self.args)

        self.assertEqual(list(self.args.out.iterdir()), [])
        self.assertEqual(list(self.root.glob(".bundle-export-*")), [])

    def test_native_failure_is_not_published(self):
        """Propagate solver failure and clean up private staging files."""
        self.model.simulate.side_effect = RuntimeError("native failure")

        with self.assertRaisesRegex(RuntimeError, "native failure"):
            exporter.export_bundle(self.args)

        self.assertEqual(list(self.args.out.iterdir()), [])
        self.assertEqual(list(self.root.glob(".bundle-export-*")), [])


class SourceIdentityTests(unittest.TestCase):
    def test_directory_pruning_preserves_source_digest(self):
        """Hash the same ordered model/config/resource inputs while excluding generated and dependency trees."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            included = {"a.mo": b"model A end A;", "package.order": b"A", "Resources/table.csv": b"data"}
            excluded = ["artifacts/generated.mo", "node_modules/library.mo", ".git/config.toml", "README.md"]

            for name, contents in {**included, **dict.fromkeys(excluded, b"ignored")}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)

            digest = hashlib.sha256()

            for name in sorted(included):
                digest.update(name.encode())
                digest.update(b"\0")
                digest.update(hashlib.sha256(included[name]).digest())

            self.assertEqual(exporter.source_identity(root)["source_sha256"], digest.hexdigest())
