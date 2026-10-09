"""Check compiler root overrides and external scenario provenance without running a solver."""

import importlib.util
from contextlib import chdir
from pathlib import Path
import tempfile
import unittest

from exporter_support import provenance, simulation
from rdd2_simulation.paths import resolve_scenario


class ScenarioLoadingTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("rumoca"), "Needs the simulation extra")
    def test_external_toml_loads_a_model_from_a_separate_nested_package(self):
        """Compile a Modelica package independently of where its scenario TOML is stored."""
        import rumoca

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            library = workspace / "library"
            configs = workspace / "configs"
            package = workspace / "custom" / "FlightPackage"
            nested = package / "Missions"
            library.mkdir()
            configs.mkdir()
            nested.mkdir(parents=True)
            (package / "package.mo").write_text("within; package FlightPackage end FlightPackage;")
            (nested / "package.mo").write_text("within FlightPackage; package Missions end Missions;")
            model_file = nested / "Flight.mo"
            model_file.write_text("within FlightPackage.Missions; model Flight parameter Real marker = 9; end Flight;")
            scenario = configs / "flight.toml"
            scenario.write_text(
                '[rumoca]\nversion = "1"\ntask = "simulate"\n'
                '[model]\nfile = "../custom/FlightPackage/Missions/Flight.mo"\nname = "FlightPackage.Missions.Flight"\n'
                '[sim]\ndt = 0.02\nsolver = "rk-like"\n'
            )

            with chdir(workspace):
                resolved = resolve_scenario(Path("configs/flight.toml"), library)
                session, model, config = simulation.load_scenario(rumoca, resolved, library)
            self.assertEqual(session.roots, [str(library), str(package)])
            self.assertEqual(model.parameters["marker"].value, 9)
            self.assertEqual(config.dt, 0.02)

            before = provenance.simulation_source_identity(library, scenario)
            (configs / "unrelated.toml").write_text("# not a simulation input\n")
            self.assertEqual(before, provenance.simulation_source_identity(library, scenario))
            model_file.write_text(model_file.read_text().replace("marker = 9", "marker = 10"))
            after = provenance.simulation_source_identity(library, scenario)
            self.assertNotEqual(before["source_sha256"], after["source_sha256"])
            self.assertEqual(before["model_sources"]["path"], str(package))

            (library / "Vehicle.mo").write_text("within; model Vehicle end Vehicle;")
            self.assertNotEqual(
                after["source_sha256"], provenance.simulation_source_identity(library, scenario)["source_sha256"]
            )

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

            resolved = resolve_scenario(scenario.relative_to(root), root)
            session, model, config = simulation.load_scenario(rumoca, resolved, root)
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

            original = scenario.read_bytes()
            _, model, config = simulation.load_scenario(rumoca, scenario, selected)
            self.assertEqual(model.parameters["marker"].value, 2)
            self.assertEqual(config.dt, 0.01)
            self.assertEqual(config.solver, "rk-like")
            self.assertEqual(scenario.read_bytes(), original)
