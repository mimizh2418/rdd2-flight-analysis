"""Check compiler root overrides and external scenario provenance without running a solver."""

import importlib.util
from contextlib import chdir
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from exporter_support import provenance, simulation
from rdd2_simulation.paths import resolve_scenario


class ScenarioLoadingTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("rumoca"), "Needs the simulation extra")
    def test_optional_feedforward_uses_available_inputs_and_ignores_only_missing_ones(self):
        """Exercise old, partial, and full controller contracts with a tiny algebraic reference, not a vehicle."""
        import rumoca

        fields = {
            "jerkWorld_m_s3": ("[3]", "jerk", "{4, 5, 6}", "[1]", 4.0),
            "snapWorld_m_s4": ("[3]", "snap", "{7, 8, 9}", "[1]", 7.0),
            "yawRate_rad_s": ("", "yawRate", "0.2", "", 0.2),
            "yawAcceleration_rad_s2": ("", "yawAcceleration", "0.3", "", 0.3),
        }
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            sources = workspace / "scenarios"
            sources.mkdir()
            (sources / "package.mo").write_text("within; package Rdd2Scenarios end Rdd2Scenarios;")
            mission = sources / "CircleMission.mo"
            mission.write_text(
                "within Rdd2Scenarios; model CircleMission\n"
                "  record Reference\n"
                "    Real position[3]; Real velocity[3]; Real acceleration[3]; Real yaw;\n"
                + "".join(f"    Real {name}{dims};\n" for dims, name, *_ in fields.values())
                + "  end Reference;\n"
                "  Reference reference; Vehicles.Rdd2.Controller controller;\n"
                "equation\n"
                "  reference.position = {1, 2, 3}; reference.velocity = zeros(3);\n"
                "  reference.acceleration = zeros(3); reference.yaw = 0.1;\n"
                + "".join(f"  reference.{name} = {value};\n" for _, name, value, *_ in fields.values())
                + "  controller.reference.positionWorld_m = reference.position;\n"
                "  controller.reference.velocityWorld_m_s = reference.velocity;\n"
                "  controller.reference.accelerationWorld_m_s2 = reference.acceleration;\n"
                "  controller.reference.yaw_rad = reference.yaw;\n"
                + "".join(f"  controller.reference.{field} = reference.{data[1]};\n" for field, data in fields.items())
                + "end CircleMission;\n"
            )
            scenario = sources / "flight.toml"
            scenario.write_text(
                '[rumoca]\nversion = "1"\ntask = "simulate"\n'
                '[model]\nfile = "CircleMission.mo"\nname = "Rdd2Scenarios.CircleMission"\n'
                '[sim]\ndt = 0.001\nsolver = "rk-like"\n'
            )
            original = mission.read_bytes()
            for index, supported in enumerate(((), ("jerkWorld_m_s3", "yawRate_rad_s"), tuple(fields))):
                with self.subTest(supported=supported):
                    root = workspace / f"library-{index}"
                    package = root / "Vehicles" / "Rdd2"
                    package.mkdir(parents=True)
                    (package.parent / "package.mo").write_text("within; package Vehicles end Vehicles;")
                    (package / "package.mo").write_text("within Vehicles; package Rdd2 end Rdd2;")
                    (package / "Controller.mo").write_text(
                        "within Vehicles.Rdd2; block Controller\n"
                        "  connector Input\n"
                        "    input Real positionWorld_m[3]; input Real velocityWorld_m_s[3];\n"
                        "    input Real accelerationWorld_m_s2[3]; input Real yaw_rad;\n"
                        + "".join(f"    input Real {field}{fields[field][0]};\n" for field in supported)
                        + "  end Input;\n"
                        "  Input reference; output Real command;\n"
                        "equation\n  command = reference.positionWorld_m[1]"
                        + "".join(f" + reference.{field}{fields[field][3]}" for field in supported)
                        + ";\nend Controller;\n"
                    )
                    with patch.object(simulation, "PROJECT_SCENARIOS", sources):
                        session, model, config = simulation.load_scenario(rumoca, scenario, root)
                    variables = model.to_dict("flat")["variables"]
                    for field, (_, signal, *_) in fields.items():
                        self.assertEqual(f"controller.reference.{field}" in variables, field in supported)
                        self.assertIn(f"reference.{signal}", variables)
                    self.assertEqual(mission.read_bytes(), original)
                    if len(supported) == len(fields):
                        self.assertEqual(session.roots, [str(root), str(sources)])
                    else:
                        self.assertFalse(Path(session.roots[-1]).exists())
                    # The prepared model must still work after the temporary source copy is removed.
                    result = model.simulate(t=(0.0, 0.001), config=config)
                    self.assertAlmostEqual(result["controller.command"][0], 1.0 + sum(fields[f][4] for f in supported))
            # This adapter must not hide unrelated Modelica errors.
            mission.write_text(
                original.decode().replace("end CircleMission;", "controller.reference.missing = 0;\nend CircleMission;")
            )
            with patch.object(simulation, "PROJECT_SCENARIOS", sources):
                with self.assertRaisesRegex(rumoca.CompileError, "controller.reference.missing"):
                    simulation.load_scenario(rumoca, scenario, workspace / "library-0")

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
