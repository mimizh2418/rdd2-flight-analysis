"""Validate scenario export, truthful timings, and provenance guards with a public-API Rumoca stub."""

from contextlib import ExitStack, chdir
import hashlib
import json
from pathlib import Path
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
    def test_default_output_uses_the_scenario_filename_and_preserves_existing_logs(self):
        """Export stub results under the working directory and reject a repeated run before calling the runtime."""
        cases = [
            ("rumoca-scenario.qualification-mocap.toml", "qualification-mocap"),
            ("rumoca-scenario-circles-mocap.toml", "circles-mocap"),
            ("rumoca-scenario.toml", "scenario"),
            ("custom.mission.toml", "custom.mission"),
        ]

        for encoding in ("arrow", "csv"):
            for index, (filename, name) in enumerate(cases):
                with self.subTest(format=encoding, scenario=filename):
                    workspace = self.root / f"case-{encoding}-{index}"
                    workspace.mkdir()
                    scenario = self.root / filename
                    scenario.write_text(self.scenario.read_text())
                    arguments = exporter.parser().parse_args(
                        ["run", str(scenario), "--modelica-root", str(self.root), "--format", encoding, "--quiet"]
                    )

                    # The library path and optional viewer name must not affect the default destination.
                    arguments.name = "Display name"
                    with chdir(workspace):
                        output = exporter.export_bundle(arguments)
                        self.assertEqual(output, workspace / "exports" / name)
                        artifact = output / f"trace.{encoding}"
                        original = artifact.read_bytes()
                        self.model.simulate.reset_mock()

                        with self.assertRaisesRegex(ValueError, "Output directory must be empty"):
                            exporter.export_bundle(arguments)

                        self.model.simulate.assert_not_called()
                        self.assertEqual(artifact.read_bytes(), original)

    def test_stop_time_overrides_the_mission_duration(self):
        """Pass a smoke-run limit to the runtime and record it in Arrow metadata, using only a stub."""
        import pyarrow as pa

        self.scenario.write_text(
            '[model]\nfile = "Vehicle.mo"\nname = "RDD2"\n[sim]\nt_end = 110\nsolver = "rk-like"\n'
        )
        self.args.stop_time = 0.05
        self.args.format = "arrow"

        # Match the stub's timestamps to the short request without invoking a native solver.
        result = ResultStub()
        result.time = [0.0, 0.025, 0.05]
        self.model.simulate.side_effect = None
        self.model.simulate.return_value = result

        output = exporter.export_bundle(self.args)
        table = pa.ipc.open_file(output / "trace.arrow").read_all()
        manifest = json.loads(table.schema.metadata[b"rdd2:manifest"])

        self.model.simulate.assert_called_once_with(t=(0.0, 0.05), config={"runtime": "config"})
        self.assertEqual(manifest["solver"]["t_end"], 0.05)
        self.assertEqual(table["time"].to_pylist(), result.time)

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
        self.assertEqual(manifest["compiler"]["native_version"], "0.10.0")
        self.assertEqual(manifest["compiler"]["native_extension_sha256"], exporter.sha256(self.native_extension))
        self.assertNotIn("cli_version", manifest["compiler"])
        self.assertNotIn("binary_sha256", manifest["compiler"])

    def setUp(self):
        """Create a Python runtime stub and reject external processes, with a deterministic stage clock."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scenario = self.root / "scenario.toml"
        self.scenario.write_text('[model]\nfile = "Vehicle.mo"\nname = "RDD2"\n[sim]\nt_end = 2\nsolver = "auto"\n')
        self.native_extension = self.root / "_native.abi3.so"
        self.native_extension.write_bytes(b"test native compiler")
        self.args = exporter.parser().parse_args(
            [
                "run",
                str(self.scenario),
                "--format",
                "csv",
                "--modelica-root",
                str(self.root),
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
        runtime = SimpleNamespace(
            Session=self.session,
            version=lambda: "0.10.0",
            _native=SimpleNamespace(__file__=str(self.native_extension)),
            __file__=str(self.root / "rumoca.py"),
        )
        patches = ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.dict(sys.modules, rumoca=runtime))
        patches.enter_context(patch.object(simulation.importlib.metadata, "version", return_value="0.10.0"))
        patches.enter_context(
            patch("subprocess.run", side_effect=AssertionError("Simulation must not invoke the Rumoca CLI"))
        )
        patches.enter_context(patch.object(progress.time, "perf_counter", side_effect=lambda: self.clock))
        self.identity = patches.enter_context(
            patch.object(simulation, "simulation_source_identity", return_value={"source_sha256": "unchanged"})
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
            self.assertEqual(path, self.native_extension)

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
