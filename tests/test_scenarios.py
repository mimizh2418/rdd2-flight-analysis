"""Compile scenarios and check isolated trajectory references; never simulate a full vehicle flight."""

import importlib.util
import math
import os
from pathlib import Path
import tomllib
import unittest

import numpy as np

from exporter_support import simulation
from rdd2_simulation.paths import PROJECT_SCENARIOS, resolve_scenario


@unittest.skipUnless(
    importlib.util.find_spec("rumoca") and os.environ.get("RDD2_MODELICA_ROOT"), "Needs Rumoca and the model library"
)
class ScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """Load all scenarios through Rumoca's frontend; never initialize or run the vehicle solver."""
        import rumoca

        root = Path(os.environ["RDD2_MODELICA_ROOT"]).expanduser().resolve()
        cls.models = {
            name: simulation.load_scenario(
                rumoca,
                resolve_scenario(PROJECT_SCENARIOS / f"rumoca-scenario.{name}.toml", root),
                root,
            )[1]
            for name in ("qualification-mocap", "circles-mocap", "figure-eight-mocap")
        }

    def test_all_missions_use_mocap_and_the_selected_reference_source(self):
        """Require mocap feedback and the mission's reference source in compiled vehicle models."""
        for name, model in self.models.items():
            with self.subTest(scenario=name):
                self.assertEqual(model.parameters["navigationSource"].value, 3)
                self.assertEqual(model.parameters["fuseMocap"].value, 1)

                # Circle rows are display samples; its source feeds the standard controller directly.
                variables = model.to_dict("flat")["variables"]
                expected_count = 8 if name == "qualification-mocap" else 36
                self.assertEqual(variables["localRoute"]["dims"], [expected_count, 3])
                if name != "qualification-mocap":
                    distance = "circleDistance_m" if name == "circles-mocap" else "arcDistance_m"
                    self.assertIn(f"avionics.missionTrajectory.{distance}", variables)
                    self.assertEqual(variables["avionics.controller.reference.positionWorld_m"]["dims"], [3])
                    self.assertEqual(model.parameters["cruiseSpeed_m_s"].value, 2.0 if name == "circles-mocap" else 2.5)
                    # Class redeclaration modifiers can be dropped by Rumoca;
                    # require the actual controller instance to receive its route.
                    parameters = (
                        ("circlePath.pathType", "circlePath.length", "verticalRoute")
                        if name == "circles-mocap"
                        else (
                            "leftPath.pathType",
                            "leftPath.length",
                            "rightPath.pathType",
                            "rightPath.length",
                            "verticalRoute",
                        )
                    )
                    for parameter in parameters:
                        self.assertIsNotNone(variables[f"avionics.{parameter}"]["binding"])
                else:
                    self.assertEqual(variables["avionics.planningTask.localWaypoint"]["dims"], [expected_count, 3])


@unittest.skipUnless(
    importlib.util.find_spec("rumoca") and os.environ.get("RDD2_MODELICA_ROOT"), "Needs Rumoca and the model library"
)
class DubinsReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """Load a reference-only probe with no plant, estimator, or flight controller."""
        import rumoca

        cls.runtime = rumoca
        cls.session = rumoca.Session(roots=[os.environ["RDD2_MODELICA_ROOT"], str(PROJECT_SCENARIOS)])
        cls.model = cls.session.loads(
            """within;
model DubinsReferenceProbe
  constant Real pi = 2.0 * asin(1.0);
  parameter Real queryTime = 0.0;
  parameter Real cruiseSpeed = 2.0;
  Rdd2Scenarios.CircleMission.DubinsCircleTrajectory source(
    circlePath = Planning.Dubins.Path(
      startPosition = {0.0, 0.0}, startHeading = 0.0,
      goalPosition = {0.0, 0.0}, goalHeading = 4.0 * pi, turnRadius = 3.0,
      pathType = Planning.Dubins.PathType.LSL,
      normalizedSegmentLength = {4.0 * pi, 0.0, 0.0}, length = 12.0 * pi, feasible = true),
    verticalRoute = [0.0, 0.0, 0.0; 0.0, 0.0, 2.0; 0.0, 0.0, 0.3; 0.0, 0.0, 0.1],
    cruiseSpeed_m_s = cruiseSpeed);
equation
  source.elapsedTime_s = queryTime + time;
end DubinsReferenceProbe;
""",
            model="DubinsReferenceProbe",
        )
        cls.samples = {}
        cls.circle_duration = 12.0 * math.pi / 2.0 + 2.0
        cls.circle_end = 3.0 + cls.circle_duration
        cls.route_end = cls.circle_end + 4.0

    @classmethod
    def sample(cls, elapsed, speed=2.0):
        """Evaluate reference equations over one millisecond at the requested mission time."""
        key = (elapsed, speed)
        if key not in cls.samples:
            result = cls.model.simulate(
                t=(0.0, 0.001),
                params={"queryTime": elapsed, "cruiseSpeed": speed},
                config=cls.runtime.SimConfig(solver="rk-like", dt=0.001),
            )
            cls.samples[key] = {
                name: np.array([result[f"source.trajectory.{name}[{axis}]"][0] for axis in range(1, 4)])
                for name in ("position", "velocity", "acceleration", "jerk", "snap")
            }
            cls.samples[key].update(
                distance=float(result["source.circleDistance_m"][0]),
                speed=float(result["source.circleSpeed_m_s"][0]),
                **{
                    name: float(result[f"source.trajectory.{name}"][0])
                    for name in ("yaw", "yawRate", "yawAcceleration")
                },
            )
        return cls.samples[key]

    def test_circle_radius_cruise_speed_and_centripetal_acceleration(self):
        """The flown reference is an exact circle at the requested physical speed."""
        for elapsed in np.linspace(5.0, self.circle_end - 2.0, 9):
            with self.subTest(elapsed=elapsed):
                sample = self.sample(float(elapsed))
                radial = sample["position"][:2] - np.array([0.0, 3.0])
                self.assertAlmostEqual(np.linalg.norm(radial), 3.0, places=8)
                self.assertAlmostEqual(sample["position"][2], 2.0, places=8)
                self.assertAlmostEqual(np.linalg.norm(sample["velocity"]), 2.0, places=8)
                self.assertAlmostEqual(radial @ sample["velocity"][:2], 0.0, places=8)
                np.testing.assert_allclose(sample["acceleration"][:2], -radial * 2.0**2 / 3.0**2, atol=1e-8)

    def test_yaw_faces_center_with_smooth_takeoff_and_continuous_lap_joins(self):
        """Face inward through ramps and lap joins, with a gentle takeoff turn."""
        for elapsed in np.linspace(3.25, self.circle_end - 0.25, 17):
            sample = self.sample(float(elapsed))
            forward = np.array([math.cos(sample["yaw"]), math.sin(sample["yaw"])])
            inward = np.array([0.0, 3.0]) - sample["position"][:2]
            np.testing.assert_allclose(forward, inward / np.linalg.norm(inward), atol=1e-8)
        # The first lap closes halfway through the symmetric circle profile.
        lap_join = 3.0 + self.circle_duration / 2.0
        self.assertAlmostEqual(self.sample(lap_join)["yaw"], 2.5 * math.pi, places=8)
        step = 1e-4
        for elapsed in (1.5, 4.0, lap_join, self.circle_end - 1.0):
            left, center, right = (self.sample(elapsed + offset) for offset in (-step, 0.0, step))
            self.assertAlmostEqual((right["yaw"] - left["yaw"]) / (2 * step), center["yawRate"], places=6)
            self.assertAlmostEqual(
                (right["yawRate"] - left["yawRate"]) / (2 * step), center["yawAcceleration"], places=6
            )
        for elapsed, heading in (
            (-1.0, 0.0),
            (self.circle_end + 1.5, 4.5 * math.pi),
            (self.route_end + 1.0, 4.5 * math.pi),
        ):
            sample = self.sample(elapsed)
            self.assertAlmostEqual(sample["yaw"], heading, places=8)
            self.assertEqual(sample["yawRate"], 0.0)
            self.assertEqual(sample["yawAcceleration"], 0.0)
        takeoff = self.sample(1.5)
        self.assertAlmostEqual(takeoff["yaw"], math.pi / 4.0, places=8)
        self.assertGreater(takeoff["yawRate"], 0.0)
        for boundary in (0.0, 3.0, self.circle_end):
            left, right = self.sample(boundary - 1e-7), self.sample(boundary + 1e-7)
            for name in ("yaw", "yawRate", "yawAcceleration"):
                self.assertAlmostEqual(left[name], right[name], places=6)

    def test_two_laps_ramp_symmetry_and_stationary_endpoints(self):
        """Ramps occupy arc distance, reach cruise speed, and finish both laps at rest."""
        length = 12.0 * math.pi
        for ramp_time in (0.0, 0.5, 1.0, 1.5, 2.0):
            outbound = self.sample(3.0 + ramp_time)
            inbound = self.sample(self.circle_end - ramp_time)
            self.assertAlmostEqual(outbound["speed"], inbound["speed"], places=8)
            self.assertAlmostEqual(outbound["distance"] + inbound["distance"], length, places=8)
            self.assertGreaterEqual(outbound["speed"], 0.0)
            self.assertLessEqual(outbound["speed"], 2.0)
        self.assertAlmostEqual(self.sample(self.circle_end)["distance"], length, places=8)
        for elapsed, position in ((-1.0, [0, 0, 0]), (self.route_end + 1.0, [0, 0, 0.1])):
            sample = self.sample(elapsed)
            np.testing.assert_allclose(sample["position"], position, atol=1e-8)
            for name in ("velocity", "acceleration", "jerk", "snap"):
                np.testing.assert_allclose(sample[name], 0.0, atol=1e-8)

    def test_vertical_timing_is_independent_of_circle_speed(self):
        """Both speeds retain gentle vertical profiles with the same phase durations."""
        for speed in (1.0, 2.0):
            circle_end = 3.0 + 12.0 * math.pi / speed + 2.0
            for elapsed, altitude in ((1.5, 1.0), (circle_end + 1.5, 1.15), (circle_end + 3.5, 0.2)):
                sample = self.sample(elapsed, speed)
                np.testing.assert_allclose(sample["position"], [0.0, 0.0, altitude], atol=1e-8)
            for elapsed in (0.83, 2.17, circle_end + 0.83, circle_end + 2.17, circle_end + 3.28):
                self.assertLess(abs(self.sample(elapsed, speed)["acceleration"][2]), 2.0)

    def test_derivatives_match_motion_and_phase_boundaries_are_continuous(self):
        """Check chain-rule feed-forward and smooth takeoff/circle/landing joins."""
        step = 1e-4
        for elapsed in (4.0, 6.0, self.circle_end - 1.0):
            left, center, right = (self.sample(elapsed + offset) for offset in (-step, 0.0, step))
            for value, derivative in (
                ("position", "velocity"),
                ("velocity", "acceleration"),
                ("acceleration", "jerk"),
                ("jerk", "snap"),
            ):
                np.testing.assert_allclose((right[value] - left[value]) / (2 * step), center[derivative], atol=2e-5)
        for boundary in (3.0, 5.0, self.circle_end - 2.0, self.circle_end, self.circle_end + 3.0, self.route_end):
            # One-second touchdown has large endpoint snap; use a close enough
            # neighborhood to check the limiting jerk rather than its slope.
            left, right = self.sample(boundary - 1e-7), self.sample(boundary + 1e-7)
            for name in ("position", "velocity", "acceleration", "jerk"):
                np.testing.assert_allclose(left[name], right[name], atol=1e-4)


@unittest.skipUnless(
    importlib.util.find_spec("rumoca") and os.environ.get("RDD2_MODELICA_ROOT"), "Needs Rumoca and the model library"
)
class FigureEightReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """Compile a figure-eight reference probe without a plant or controller."""
        import rumoca

        cls.runtime = rumoca
        cls.session = rumoca.Session(roots=[os.environ["RDD2_MODELICA_ROOT"], str(PROJECT_SCENARIOS)])
        cls.model = cls.session.loads(
            """within;
model FigureEightReferenceProbe
  constant Real pi = 2.0 * asin(1.0);
  parameter Real queryTime = 0.0;
  parameter Real cruiseSpeed = 2.5;
  Rdd2Scenarios.FigureEightMission.FigureEightTrajectory source(
    leftPath = Planning.Dubins.Path(
      startPosition = {0.0, 0.0}, startHeading = 0.0,
      goalPosition = {-3.0 * sin(0.5), 3.0 * (1.0 - cos(0.5))},
      goalHeading = 2.0 * pi - 0.5, turnRadius = 3.0,
      pathType = Planning.Dubins.PathType.LSL,
      normalizedSegmentLength = {2.0 * pi - 0.5, 0.0, 0.0},
      length = 3.0 * (2.0 * pi - 0.5), feasible = true),
    rightPath = Planning.Dubins.Path(
      startPosition = {3.0 * sin(0.5), -3.0 * (1.0 - cos(0.5))},
      startHeading = 2.0 * pi - 0.5,
      goalPosition = {0.0, 0.0}, goalHeading = 0.0, turnRadius = 3.0,
      pathType = Planning.Dubins.PathType.RSR,
      normalizedSegmentLength = {2.0 * pi - 0.5, 0.0, 0.0},
      length = 3.0 * (2.0 * pi - 0.5), feasible = true),
    verticalRoute = [0.0, 0.0, 0.0; 0.0, 0.0, 2.0; 0.0, 0.0, 0.3; 0.0, 0.0, 0.1],
    cruiseSpeed_m_s = cruiseSpeed,
    crossingDuration_s = 0.98 * 3.0 / cruiseSpeed);
equation
  source.elapsedTime_s = queryTime + time;
end FigureEightReferenceProbe;
""",
            model="FigureEightReferenceProbe",
        )
        cls.samples = {}
        cls.arc_duration = 3.0 * (2.0 * math.pi - 0.5) / 2.5 + 1.0
        cls.crossing_duration = 0.98 * 3.0 / 2.5
        cls.crossing_start = 3.0 + cls.arc_duration
        cls.crossing_end = cls.crossing_start + cls.crossing_duration
        cls.figure_end = cls.crossing_end + cls.arc_duration
        cls.route_end = cls.figure_end + 4.0

    @classmethod
    def sample(cls, elapsed, speed=2.5):
        key = (elapsed, speed)
        if key not in cls.samples:
            result = cls.model.simulate(
                t=(0.0, 0.001),
                params={"queryTime": elapsed, "cruiseSpeed": speed},
                config=cls.runtime.SimConfig(solver="rk-like", dt=0.001),
            )
            cls.samples[key] = {
                name: np.array([result[f"source.trajectory.{name}[{axis}]"][0] for axis in range(1, 4)])
                for name in ("position", "velocity", "acceleration", "jerk", "snap")
            }
            cls.samples[key].update(
                {name: float(result[f"source.trajectory.{name}"][0]) for name in ("yaw", "yawRate", "yawAcceleration")}
            )
        return cls.samples[key]

    def test_opposite_dubins_lobes_and_nonstopping_center_crossing(self):
        for start, end, center in (
            (5.0, self.crossing_start, np.array([0.0, 3.0])),
            (self.crossing_end, self.figure_end - 2.0, np.array([0.0, -3.0])),
        ):
            for elapsed in np.linspace(start, end, 7):
                sample = self.sample(float(elapsed))
                self.assertAlmostEqual(np.linalg.norm(sample["position"][:2] - center), 3.0, places=8)
                self.assertAlmostEqual(np.linalg.norm(sample["velocity"]), 2.5, places=8)
                self.assertAlmostEqual(sample["position"][2], 2.0, places=8)
        middle = self.sample((self.crossing_start + self.crossing_end) / 2.0)
        np.testing.assert_allclose(middle["position"], [0.0, 0.0, 2.0], atol=1e-8)
        for elapsed in np.linspace(self.crossing_start, self.crossing_end, 41):
            sample = self.sample(float(elapsed))
            speed = np.linalg.norm(sample["velocity"])
            self.assertGreaterEqual(speed, 2.5 - 1e-8)
            self.assertLess(speed, 2.65)
            forward = np.array([math.cos(sample["yaw"]), math.sin(sample["yaw"])])
            np.testing.assert_allclose(forward, sample["velocity"][:2] / speed, atol=1e-8)

    def test_motion_and_tangent_yaw_derivatives_and_smooth_joins(self):
        step = 1e-4
        for elapsed in (
            4.0,
            6.0,
            self.crossing_start + 0.3 * self.crossing_duration,
            self.crossing_start + 0.5 * self.crossing_duration,
            self.crossing_end + 1.0,
            self.figure_end - 1.0,
        ):
            left, center, right = (self.sample(elapsed + offset) for offset in (-step, 0.0, step))
            for value, derivative in (
                ("position", "velocity"),
                ("velocity", "acceleration"),
                ("acceleration", "jerk"),
                ("jerk", "snap"),
            ):
                np.testing.assert_allclose((right[value] - left[value]) / (2 * step), center[derivative], atol=3e-5)
            self.assertAlmostEqual((right["yaw"] - left["yaw"]) / (2 * step), center["yawRate"], places=6)
            self.assertAlmostEqual(
                (right["yawRate"] - left["yawRate"]) / (2 * step), center["yawAcceleration"], places=6
            )
            forward = np.array([math.cos(center["yaw"]), math.sin(center["yaw"])])
            np.testing.assert_allclose(forward, center["velocity"][:2] / np.linalg.norm(center["velocity"]), atol=1e-8)
        for boundary in (
            3.0,
            5.0,
            self.crossing_start,
            self.crossing_end,
            self.figure_end - 2.0,
            self.figure_end,
            self.figure_end + 3.0,
            self.route_end,
        ):
            left, right = self.sample(boundary - 1e-7), self.sample(boundary + 1e-7)
            for name in ("position", "velocity", "acceleration", "jerk", "yaw", "yawRate", "yawAcceleration"):
                np.testing.assert_allclose(left[name], right[name], atol=1e-4)

    def test_reference_acceleration_thrust_and_yaw_moment_have_margin(self):
        """Check reference demand against the RDD2 limits; this is not a closed-loop qualification."""
        elapsed_times = np.unique(
            np.concatenate(
                (
                    np.linspace(0.0, 3.0, 13),
                    np.linspace(3.0, 5.0, 13),
                    np.linspace(self.crossing_start, self.crossing_end, 41),
                    np.linspace(self.figure_end - 2.0, self.figure_end, 13),
                    np.linspace(self.figure_end, self.figure_end + 3.0, 13),
                    np.linspace(self.figure_end + 3.0, self.route_end, 13),
                )
            )
        )
        peak_thrust, peak_yaw_moment = 0.0, 0.0
        for elapsed in elapsed_times:
            sample = self.sample(float(elapsed))
            acceleration = sample["acceleration"]
            self.assertLess(np.linalg.norm(acceleration[:2]), 3.0)
            self.assertLess(abs(acceleration[2]), 2.0)
            peak_thrust = max(peak_thrust, 2.0 * np.linalg.norm(acceleration + np.array([0.0, 0.0, 9.80665])))
            peak_yaw_moment = max(peak_yaw_moment, 0.04 * abs(sample["yawAcceleration"]))
        max_thrust = 4.0 * 8.54858e-6 * 1100.0**2
        self.assertLess(peak_thrust, 0.7 * max_thrust)
        self.assertLess(peak_yaw_moment, 0.25)  # Allocator's yaw limit is 0.30 Nm.
        print(
            f"\nFigure-eight reference peaks: thrust {peak_thrust:.2f} N / {max_thrust:.2f} N; "
            f"yaw inertia demand {peak_yaw_moment:.3f} Nm / 0.30 Nm"
        )

    def test_origin_takeoff_landing_independent_vertical_timing_and_end_margin(self):
        for elapsed, position in ((-1.0, [0.0, 0.0, 0.0]), (self.route_end + 1.0, [0.0, 0.0, 0.1])):
            sample = self.sample(elapsed)
            np.testing.assert_allclose(sample["position"], position, atol=1e-8)
            for name in ("velocity", "acceleration", "jerk", "snap", "yawRate", "yawAcceleration"):
                np.testing.assert_allclose(sample[name], 0.0, atol=1e-8)
        for speed in (2.0, 2.5):
            arc_duration = 3.0 * (2.0 * math.pi - 0.5) / speed + 1.0
            figure_end = 3.0 + 2.0 * arc_duration + 0.98 * 3.0 / speed
            for elapsed, altitude in ((1.5, 1.0), (figure_end + 1.5, 1.15), (figure_end + 3.5, 0.2)):
                np.testing.assert_allclose(self.sample(elapsed, speed)["position"], [0.0, 0.0, altitude], atol=1e-8)
        scenario = tomllib.loads((PROJECT_SCENARIOS / "rumoca-scenario.figure-eight-mocap.toml").read_text())
        end_time = scenario["sim"]["t_end"]
        self.assertEqual(end_time % 5, 0.0)
        self.assertGreaterEqual(end_time - (1.0 + self.route_end + 3.0), 5.0)
