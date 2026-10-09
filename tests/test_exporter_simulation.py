"""Check simulation exports and source provenance with a small public-API Rumoca stub."""

from contextlib import ExitStack, chdir
import csv
import json
import os
from pathlib import Path
from subprocess import CompletedProcess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import pyarrow as pa

from exporter_support import exporter, provenance, simulation


class ResultStub:
    """Expose only the public result properties and supported telemetry used by the exporter."""

    names = ["time", "position_m[1]", "internal.unsupported"]
    time = [0.0, 1.0, 1.0000000000000002]
    termination = "completed"
    metrics = {"simulate_seconds": 4.5, "points": 3, "variables": 3}

    def __getitem__(self, name):
        """Return supported samples and reject extraction of unrecognized result columns."""
        if name != "position_m[1]":
            raise AssertionError(f"Unexpected channel extraction: {name}")

        return [0.0, 2.0, 3.0]


class SimulationTests(unittest.TestCase):
    def setUp(self):
        """Provide a temporary scenario and stub runtime without invoking a native solver."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scenario = self.root / "rumoca-scenario.test-mission.toml"
        self.scenario.write_text('[model]\nfile = "Vehicle.mo"\nname = "RDD2"\n[sim]\nt_end = 2\nsolver = "auto"\n')
        self.native_extension = self.root / "_native.abi3.so"
        self.native_extension.write_bytes(b"test native compiler")
        self.args = exporter.parser().parse_args(
            [
                "run",
                str(self.scenario),
                "--modelica-root",
                str(self.root),
                "--out",
                str(self.root / "bundle"),
                "--quiet",
            ]
        )

        self.model = Mock()
        self.model.simulate.return_value = ResultStub()
        session = Mock()
        session.from_scenario.return_value = (object(), self.model, {"runtime": "config"})
        runtime = SimpleNamespace(
            Session=session,
            version=lambda: "0.10.0",
            _native=SimpleNamespace(__file__=str(self.native_extension)),
            __file__=str(self.root / "rumoca.py"),
        )

        patches = ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.dict(sys.modules, rumoca=runtime))
        patches.enter_context(patch.object(simulation.importlib.metadata, "version", return_value="0.10.0"))
        self.identity = patches.enter_context(
            patch.object(simulation, "simulation_source_identity", return_value={"source_sha256": "unchanged"})
        )

    def test_stop_time_override_is_exported_at_the_default_destination(self):
        """Limit the requested simulation duration and retain its timestamps and effective settings in Arrow."""
        self.scenario.write_text('[model]\nfile = "Vehicle.mo"\nname = "RDD2"\n[sim]\nt_end = 110\n')
        self.args.stop_time = 0.05
        self.args.out = None
        result = ResultStub()
        result.time = [0.0, 0.025, 0.05]
        self.model.simulate.return_value = result

        with chdir(self.root):
            output = exporter.export_bundle(self.args)

        self.assertEqual(output, self.root / "exports" / "test-mission")
        table = pa.ipc.open_file(output / "trace.arrow").read_all()
        manifest = json.loads(table.schema.metadata[b"rdd2:manifest"])

        self.model.simulate.assert_called_once_with(t=(0.0, 0.05), config={"runtime": "config"})
        self.assertEqual(manifest["solver"]["t_end"], 0.05)
        self.assertEqual(table["time"].to_pylist(), result.time)

    def test_simulation_exports_telemetry_and_provenance_in_both_formats(self):
        """Export supported native channels with event timestamps, solver metrics, and compiler identity."""
        for encoding in ("arrow", "csv"):
            with self.subTest(format=encoding):
                self.args.format = encoding
                self.args.out = self.root / encoding
                self.model.simulate.reset_mock()
                output = exporter.export_bundle(self.args)

                if encoding == "arrow":
                    self.assertEqual({file.name for file in output.iterdir()}, {"trace.arrow"})
                    table = pa.ipc.open_file(output / "trace.arrow").read_all()
                    manifest = json.loads(table.schema.metadata[b"rdd2:manifest"])
                    times = table["time"].to_pylist()
                    positions = table["position_m[1]"].to_pylist()
                else:
                    manifest = json.loads((output / "manifest.json").read_text())
                    with (output / "trace.csv").open(newline="") as stream:
                        rows = list(csv.DictReader(stream))
                    times = [float(row["time"]) for row in rows]
                    positions = [float(row["position_m[1]"]) for row in rows]
                    self.assertEqual(manifest["csv_sha256"], exporter.sha256(output / "trace.csv"))

                self.assertEqual(times, ResultStub.time)
                self.assertEqual(positions, [0.0, 2.0, 3.0])
                self.assertEqual(list(manifest["signals"]), ["position_m[1]"])
                self.assertEqual(manifest["rumoca_metrics"], ResultStub.metrics)
                self.assertEqual(manifest["coverage_status"], "partial")
                self.assertEqual(manifest["compiler"]["python_version"], "0.10.0")
                self.assertEqual(manifest["compiler"]["native_version"], "0.10.0")
                self.assertEqual(
                    manifest["compiler"]["native_extension_sha256"], exporter.sha256(self.native_extension)
                )
                self.model.simulate.assert_called_once_with(t=(0.0, 2.0), config={"runtime": "config"})

    def test_changed_model_inputs_prevent_publication(self):
        """Reject a result whose source models changed during simulation."""
        self.identity.side_effect = [{"source_sha256": "before"}, {"source_sha256": "after"}]

        with self.assertRaisesRegex(RuntimeError, "Model inputs changed"):
            exporter.export_bundle(self.args)

        self.assertFalse(self.args.out.exists())
        self.assertEqual(list(self.root.glob(".bundle-export-*")), [])


class SourceIdentityTests(unittest.TestCase):
    def test_pin_and_digest_identify_the_actual_model_sources(self):
        """Use the pin only for its matching library and exclude generated files from its fingerprint."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pinned = root / "pinned"
            developer = root / "developer"
            pinned.mkdir()
            developer.mkdir()
            model = pinned / "Vehicle.mo"
            model.write_text("model Vehicle end Vehicle;")
            revision = "test-pinned-revision"

            with (
                patch.dict(os.environ, {"RDD2_MODELICA_ROOT": str(pinned), "RDD2_MODELICA_REVISION": revision}),
                patch.object(provenance.subprocess, "run", return_value=CompletedProcess([], 128, "", "no repository")),
            ):
                identity = exporter.source_identity(pinned)
                self.assertEqual(identity["model_revision"], revision)
                self.assertIsNone(identity["working_tree_dirty"])
                self.assertIsNone(exporter.source_identity(developer)["model_revision"])

                for name in ("artifacts/generated.mo", "node_modules/library.mo"):
                    generated = pinned / name
                    generated.parent.mkdir()
                    generated.write_text("ignored")

                self.assertEqual(exporter.source_identity(pinned)["source_sha256"], identity["source_sha256"])
                model.write_text("model Vehicle parameter Real mass = 1; end Vehicle;")
                self.assertNotEqual(exporter.source_identity(pinned)["source_sha256"], identity["source_sha256"])

                with patch.object(
                    provenance.subprocess, "run", return_value=CompletedProcess([], 0, "local-revision", "")
                ):
                    self.assertEqual(exporter.source_identity(pinned)["model_revision"], "local-revision")
