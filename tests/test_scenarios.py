"""Compile local scenarios against the selected model library without executing simulations."""

import importlib.util
import os
from pathlib import Path
import unittest

from exporter_support import simulation
from rdd2_simulation.paths import PROJECT_SCENARIOS, resolve_scenario


@unittest.skipUnless(
    importlib.util.find_spec("rumoca") and os.environ.get("RDD2_MODELICA_ROOT"), "Needs Rumoca and the model library"
)
class ScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """Load both scenarios through Rumoca's frontend; never initialize or run the solver."""
        import rumoca

        root = Path(os.environ["RDD2_MODELICA_ROOT"]).expanduser().resolve()
        cls.models = {
            name: simulation.load_scenario(
                rumoca,
                resolve_scenario(PROJECT_SCENARIOS / f"rumoca-scenario.{name}.toml", root),
                root,
            )[1]
            for name in ("qualification-mocap", "circles-mocap")
        }

    def test_both_missions_use_mocap_and_the_upstream_waypoint_planner(self):
        """Require mocap feedback and the standard planner in both compiled full vehicle models."""
        for name, model in self.models.items():
            with self.subTest(scenario=name):
                self.assertEqual(model.parameters["navigationSource"].value, 3)
                self.assertEqual(model.parameters["fuseMocap"].value, 1)

                # Flattened dimensions verify that each route reaches the inherited waypoint planner.
                variables = model.to_dict("flat")["variables"]
                expected_count = 84 if name == "circles-mocap" else 8
                self.assertEqual(variables["localRoute"]["dims"], [expected_count, 3])
                self.assertEqual(variables["avionics.planningTask.localWaypoint"]["dims"], [expected_count, 3])

    def test_upstream_mocap_scenario_compiles_with_the_library_root_only(self):
        """Exercise the vehicle Test package layout through the same loader used by the CLI."""
        import rumoca

        root = Path(os.environ["RDD2_MODELICA_ROOT"]).expanduser().resolve()
        scenario = root / "Vehicles/Rdd2/Test/rumoca-scenario.waypoint-mocap.toml"
        session, model, config = simulation.load_scenario(rumoca, scenario, root)

        self.assertEqual(session.roots, [str(root)])
        self.assertEqual(model.name, "Vehicles.Rdd2.Test.MocapWaypointMission")
        self.assertEqual(model.parameters["navigationSource"].value, 3)
        self.assertEqual(config.solver, "rk-like")
