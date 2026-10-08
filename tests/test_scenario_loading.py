"""Check compiler root overrides and external scenario provenance without running a solver."""

import importlib.util
from pathlib import Path
from subprocess import CompletedProcess
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from exporter_support import provenance, simulation


class ScenarioLoadingTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("rumoca"), "Needs the simulation extra")
    def test_nested_library_scenario_preserves_its_package_namespace(self):
        """Compile a nested mission without treating its package directory as a second top-level root."""
        import rumoca

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "ProbeLibrary"
            nested = package / "Missions"
            nested.mkdir(parents=True)
            (package / "package.mo").write_text("within; package ProbeLibrary end ProbeLibrary;")
            (nested / "package.mo").write_text("within ProbeLibrary; package Missions end Missions;")
            (nested / "Flight.mo").write_text(
                "within ProbeLibrary.Missions; model Flight parameter Real marker = 7; end Flight;"
            )
            scenario = nested / "rumoca-scenario.flight.toml"
            scenario.write_text(
                'source_roots = ["../.."]\n'
                '[rumoca]\nversion = "1"\ntask = "simulate"\n'
                '[model]\nfile = "Flight.mo"\nname = "ProbeLibrary.Missions.Flight"\n'
                '[sim]\ndt = 0.005\nsolver = "rk-like"\n'
            )

            session, model, config = simulation.load_scenario(rumoca, scenario, root)
            self.assertEqual(session.roots, [str(root)])
            self.assertEqual(model.name, "ProbeLibrary.Missions.Flight")
            self.assertEqual(model.parameters["marker"].value, 7)
            self.assertEqual(config.dt, 0.005)

    @unittest.skipUnless(importlib.util.find_spec("rumoca"), "Needs the simulation extra")
    def test_real_compiler_uses_the_selected_library_instead_of_toml_roots(self):
        """Compile a tiny inheritance probe with conflicting library versions; never start a solver."""
        import rumoca

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            selected = workspace / "selected"
            stale = workspace / "stale"
            for root, marker in ((selected, 2), (stale, 1)):
                package = root / "ProbeLibrary"
                package.mkdir(parents=True)
                (package / "package.mo").write_text(
                    f"within; package ProbeLibrary model Base parameter Real marker = {marker}; "
                    "end Base; end ProbeLibrary;"
                )

            sources = workspace / "scenarios"
            sources.mkdir()
            scenario = sources / "flight.toml"
            (sources / "Mission.mo").write_text("within; model Mission extends ProbeLibrary.Base; end Mission;")
            scenario.write_text(
                f'source_roots = ["{stale.as_posix()}"]\n'
                '[rumoca]\nversion = "1"\ntask = "simulate"\n'
                '[model]\nfile = "Mission.mo"\nname = "Mission"\n'
                '[sim]\ndt = 0.01\nsolver = "rk-like"\n'
            )

            _, model, config = simulation.load_scenario(rumoca, scenario, selected)
            self.assertEqual(model.parameters["marker"].value, 2)
            self.assertEqual(config.dt, 0.01)
            self.assertEqual(config.solver, "rk-like")

    def test_selected_root_reaches_the_compiler_and_preserves_settings(self):
        """Override TOML library roots while keeping model selection and solver settings unchanged."""
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            library = workspace / "developer-models"
            scenarios = workspace / "scenarios"
            scenarios.mkdir()
            scenario = scenarios / "flight.toml"
            scenario.write_text(
                'source_roots = ["../stale-models"]\n'
                '[model]\nfile = "Vehicle.mo"\nname = "Mission.Vehicle"\n'
                '[rumoca]\ntask = "simulate"\nversion = "1"\n'
                '[sim]\nsolver = "rk-like"\ndt = 0.01\nt_end = 45\nrtol = 1e-6\n'
            )
            compiled = (object(), object(), object())
            captured = []

            def compile_scenario(filename):
                """Capture Rumoca's actual configuration while the temporary TOML exists."""
                effective = Path(filename)
                config = tomllib.loads(effective.read_text())
                captured.append(effective)

                self.assertEqual(config["source_roots"], [str(library), str(scenarios)])
                self.assertEqual(config["model"], {"file": str(scenarios / "Vehicle.mo"), "name": "Mission.Vehicle"})
                self.assertEqual(config["sim"], {"solver": "rk-like", "dt": 0.01, "t_end": 45, "rtol": 1e-6})
                self.assertEqual(config["rumoca"], {"task": "simulate", "version": "1"})
                return compiled

            runtime = SimpleNamespace(Session=SimpleNamespace(from_scenario=Mock(side_effect=compile_scenario)))
            original = scenario.read_bytes()
            self.assertEqual(simulation.load_scenario(runtime, scenario, library), compiled)
            self.assertFalse(captured[0].exists())
            self.assertEqual(scenario.read_bytes(), original)

    def test_external_scenario_models_are_included_in_source_identity(self):
        """Changing either repository's models changes the combined digest while preserving library identity."""
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            library = workspace / "models"
            scenarios = workspace / "scenarios"
            library.mkdir()
            scenarios.mkdir()
            (library / "Vehicle.mo").write_text("model Vehicle end Vehicle;")
            mission = scenarios / "Mission.mo"
            mission.write_text("model Mission end Mission;")
            scenario = scenarios / "flight.toml"
            scenario.write_text('[model]\nfile = "Mission.mo"\nname = "Mission"\n')

            with patch.object(provenance.subprocess, "run", return_value=CompletedProcess([], 128, "", "")):
                before = provenance.simulation_source_identity(library, scenario)
                mission.write_text("model Mission parameter Real speed = 2; end Mission;")
                after_scenario_edit = provenance.simulation_source_identity(library, scenario)
                (library / "Vehicle.mo").write_text("model Vehicle parameter Real mass = 1; end Vehicle;")
                after_library_edit = provenance.simulation_source_identity(library, scenario)

            self.assertNotEqual(before["source_sha256"], after_scenario_edit["source_sha256"])
            self.assertNotEqual(after_scenario_edit["source_sha256"], after_library_edit["source_sha256"])
            self.assertEqual(before["scenario_sources"]["path"], str(scenarios))
            self.assertEqual(before["model_revision"], after_scenario_edit["model_revision"])
