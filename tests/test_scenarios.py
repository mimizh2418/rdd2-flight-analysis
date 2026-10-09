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
                expected_count = {"qualification-mocap": 8, "circles-mocap": 36, "figure-eight-mocap": 68}[name]
                self.assertEqual(variables["localRoute"]["dims"], [expected_count, 3])
                if name != "qualification-mocap":
                    distance = "circleDistance_m" if name == "circles-mocap" else "phase_rad"
                    self.assertIn(f"avionics.missionTrajectory.{distance}", variables)
                    self.assertEqual(variables["avionics.controller.reference.positionWorld_m"]["dims"], [3])
                    self.assertEqual(
                        model.parameters["cruiseSpeed_m_s"].value, 2.0 if name == "circles-mocap" else 8.25
                    )
                    # Class redeclaration modifiers can be dropped by Rumoca;
                    # require the actual controller instance to receive its route.
                    parameters = (
                        ("circlePath.pathType", "circlePath.length", "verticalRoute")
                        if name == "circles-mocap"
                        else (
                            "longitudinalAmplitude_m",
                            "lateralAmplitude_m",
                            "verticalRoute",
                        )
                    )
                    for parameter in parameters:
                        self.assertIsNotNone(variables[f"avionics.{parameter}"]["binding"])
                    if name == "figure-eight-mocap":
                        self.assertEqual(variables["avionics.missionTrajectory.controlPoint"]["dims"], [8, 2, 10])
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
        """Compile reference and wrench estimates without a plant or controller."""
        import rumoca

        cls.runtime = rumoca
        cls.session = rumoca.Session(roots=[os.environ["RDD2_MODELICA_ROOT"], str(PROJECT_SCENARIOS)])
        cls.model = cls.session.loads(
            """within;
model FigureEightReferenceProbe
  parameter Real queryTime = 0.0;
  parameter Real cruiseSpeed = 8.25;
  Rdd2Scenarios.FigureEightMission.FigureEightTrajectory source(
    verticalRoute = [0.0, 0.0, 0.0; 0.0, 0.0, 2.0; 0.0, 0.0, 0.3; 0.0, 0.0, 0.1],
    cruiseSpeed_m_s = cruiseSpeed);
  Planning.Bezier.FlatReference nominal;
  Vehicles.Rdd2.RotorGeometry geometry;
  Real inverse[4, 4];
  Real bodyVelocity[3];
  Real dragBody[3];
  Real forceWithDrag[3];
  Real thrustWithDrag;
  Real dampedMoment[3];
  Real rotorThrust[4];
equation
  source.elapsedTime_s = queryTime + time;
  nominal = Planning.Bezier.flatReference(source.trajectory, 2.0, 9.8,
    diagonal({0.02166666666666667, 0.02166666666666667, 0.04}));
  inverse = Control.Multirotor.Allocation.quadrotorWrenchToThrust(
    geometry.positionBodyFlu_m, geometry.yawMomentPerThrust_m);
  bodyVelocity = transpose(nominal.bodyToWorld) * source.trajectory.velocity;
  dragBody = -0.5 * 1.225 * sqrt(bodyVelocity * bodyVelocity)
    * {0.06, 0.08, 0.12} .* bodyVelocity - {0.12, 0.12, 0.18} .* bodyVelocity;
  forceWithDrag = {0.0, 0.0, nominal.thrust} - dragBody;
  thrustWithDrag = sqrt(forceWithDrag * forceWithDrag);
  dampedMoment = nominal.momentBody
    + {0.02, 0.02, 0.01} .* nominal.angularVelocityBody;
  rotorThrust = inverse * cat(1, {thrustWithDrag}, dampedMoment);
end FigureEightReferenceProbe;
""",
            model="FigureEightReferenceProbe",
        )
        cls.samples = {}
        cls.peak_speed = 8.25
        cls.phase_rate = cls.peak_speed / math.sqrt(72.0)
        cls.horizontal_duration = 2.0 * math.pi / cls.phase_rate + 2.0
        cls.crossing_time = 3.0 + 0.5 * cls.horizontal_duration
        cls.figure_end = 3.0 + cls.horizontal_duration
        cls.route_end = cls.figure_end + 4.0

    @classmethod
    def sample(cls, elapsed, speed=8.25):
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
            cls.samples[key]["phase"] = float(result["source.phase_rad"][0])
        return cls.samples[key]

    def test_lissajous_shape_and_fast_transverse_center_crossing(self):
        for elapsed in np.linspace(3.0, self.figure_end, 65):
            sample = self.sample(float(elapsed))
            x, y, z = sample["position"]
            self.assertLessEqual(abs(x), 6.0 + 1e-8)
            self.assertLessEqual(abs(y), 3.0 + 1e-8)
            phase = sample["phase"]
            np.testing.assert_allclose(
                [x, y], [6.0 * math.sin(phase), 3.0 * math.sin(2.0 * phase)], atol=1e-6, rtol=0.0
            )
            self.assertAlmostEqual(z, 2.0)
            if 5.0 <= elapsed <= self.figure_end - 2.0:
                self.assertGreater(np.linalg.norm(sample["velocity"]), 3.0)
        middle = self.sample(self.crossing_time)
        np.testing.assert_allclose(middle["position"], [0.0, 0.0, 2.0], atol=1e-8)
        np.testing.assert_allclose(
            middle["velocity"],
            [-self.peak_speed / math.sqrt(2.0), self.peak_speed / math.sqrt(2.0), 0.0],
            atol=1e-8,
        )
        entry = self.sample(3.0 + 1e-3)
        entry_direction = entry["velocity"] / np.linalg.norm(entry["velocity"])
        crossing_direction = middle["velocity"] / self.peak_speed
        self.assertAlmostEqual(float(entry_direction @ crossing_direction), 0.0, places=6)
        for elapsed in np.linspace(self.crossing_time - 0.05, self.crossing_time + 0.05, 7):
            speed = np.linalg.norm(self.sample(float(elapsed))["velocity"])
            self.assertGreaterEqual(speed, 0.99 * self.peak_speed)
            self.assertLessEqual(speed, self.peak_speed + 1e-8)

    def test_motion_and_tangent_yaw_derivatives_and_smooth_joins(self):
        step = 1e-4
        for elapsed in (1.5, 4.0, 5.1, self.crossing_time, self.figure_end - 1.0, self.figure_end + 1.5):
            left, center, right = (self.sample(elapsed + offset) for offset in (-step, 0.0, step))
            for value, derivative in (
                ("position", "velocity"),
                ("velocity", "acceleration"),
                ("acceleration", "jerk"),
                ("jerk", "snap"),
            ):
                np.testing.assert_allclose(
                    (right[value] - left[value]) / (2 * step), center[derivative], atol=1e-4, rtol=1e-6
                )
            self.assertAlmostEqual((right["yaw"] - left["yaw"]) / (2 * step), center["yawRate"], places=6)
            self.assertAlmostEqual(
                (right["yawRate"] - left["yawRate"]) / (2 * step), center["yawAcceleration"], places=6
            )
            if 3.0 < elapsed < self.figure_end:
                forward = np.array([math.cos(center["yaw"]), math.sin(center["yaw"])])
                np.testing.assert_allclose(
                    forward, center["velocity"][:2] / np.linalg.norm(center["velocity"]), atol=1e-8
                )
        yaw_branches = [4.0 + angle / self.phase_rate for angle in (0.75 * math.pi, 1.25 * math.pi)]
        # Cruise joins occur at fixed phase increments. The first and last
        # joins are inside the phase ramps; invert their Bezier phase profile.
        curve_joins = [4.0 + i * math.pi / (4.0 * self.phase_rate) for i in range(2, 7)]
        low, high = 0.0, 1.0
        for _ in range(50):
            q = (low + high) / 2.0
            phase = 2.0 * self.phase_rate * (7 * q**5 - 14 * q**6 + 10 * q**7 - 2.5 * q**8)
            if phase < math.pi / 4.0:
                low = q
            else:
                high = q
        curve_joins.extend([3.0 + 2.0 * q, self.figure_end - 2.0 * q])
        for boundary in (
            3.0,
            5.0,
            *yaw_branches,
            *curve_joins,
            self.figure_end - 2.0,
            self.figure_end,
            self.figure_end + 3.0,
            self.route_end,
        ):
            left, right = self.sample(boundary - 1e-7), self.sample(boundary + 1e-7)
            for name in ("position", "velocity", "acceleration", "jerk", "yaw", "yawRate", "yawAcceleration"):
                np.testing.assert_allclose(left[name], right[name], atol=1e-4)
        for boundary in curve_joins:
            left, right = self.sample(boundary - 1e-7), self.sample(boundary + 1e-7)
            np.testing.assert_allclose(left["snap"], right["snap"], atol=1e-4)

    def test_reference_wrench_and_individual_rotors_have_headroom(self):
        """Dense reference-only sweep with rigid-body coupling, drag, and rate damping."""
        result = self.model.simulate(
            t=(0.0, self.route_end + 0.01),
            config=self.runtime.SimConfig(solver="rk-like", dt=0.002),
        )
        thrust = np.asarray(result["nominal.thrust"])
        thrust_drag = np.asarray(result["thrustWithDrag"])
        moment = np.array([result[f"dampedMoment[{axis}]"] for axis in range(1, 4)])
        rotors = np.array([result[f"rotorThrust[{axis}]"] for axis in range(1, 5)])
        rotor_limit = 8.54858e-6 * 1100.0**2
        peak_rotor_fraction = float(np.max(rotors) / rotor_limit)
        self.assertGreaterEqual(float(np.min(rotors)), 0.0)
        self.assertLess(peak_rotor_fraction, 0.91)
        self.assertGreater(peak_rotor_fraction, 0.85)
        self.assertLess(float(np.max(thrust_drag)), 0.8 * 4.0 * rotor_limit)
        np.testing.assert_array_less(np.max(np.abs(moment), axis=1), 0.85 * np.array([2.6, 2.6, 0.30]))
        self.assertLess(float(np.max(result["source.speed_m_s"])), self.peak_speed + 1e-7)
        print(
            f"\nBezier figure-eight reference peaks: thrust {np.max(thrust):.2f} N "
            f"({np.max(thrust_drag):.2f} N with drag allowance); "
            f"yaw moment {np.max(np.abs(moment[2])):.3f} Nm / 0.30 Nm; "
            f"individual rotor {peak_rotor_fraction:.1%} of maximum thrust"
        )

    def test_origin_takeoff_landing_independent_vertical_timing_and_end_margin(self):
        for elapsed, position in ((-1.0, [0.0, 0.0, 0.0]), (self.route_end + 1.0, [0.0, 0.0, 0.1])):
            sample = self.sample(elapsed)
            np.testing.assert_allclose(sample["position"], position, atol=1e-8)
            for name in ("velocity", "acceleration", "jerk", "snap", "yawRate", "yawAcceleration"):
                np.testing.assert_allclose(sample[name], 0.0, atol=1e-8)
        for speed in (4.0, self.peak_speed):
            figure_end = 3.0 + 2.0 * math.pi * math.sqrt(72.0) / speed + 2.0
            for elapsed, altitude in ((1.5, 1.0), (figure_end + 1.5, 1.15), (figure_end + 3.5, 0.2)):
                np.testing.assert_allclose(self.sample(elapsed, speed)["position"], [0.0, 0.0, altitude], atol=1e-8)
        scenario = tomllib.loads((PROJECT_SCENARIOS / "rumoca-scenario.figure-eight-mocap.toml").read_text())
        end_time = scenario["sim"]["t_end"]
        self.assertEqual(end_time % 5, 0.0)
        self.assertGreaterEqual(end_time - (1.0 + self.route_end + 3.0), 5.0)
