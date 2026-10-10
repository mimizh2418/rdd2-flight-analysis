# RDD2 scenarios

All missions extend `Vehicles.Rdd2.WaypointVehicleSystem` directly and use its plant, noisy sensors, mocap-aided
estimator (`navigationSource = 3`, `fuseMocap = true`), and standard guidance/rate control. Qualification uses the
upstream waypoint planner; circles use Dubins arcs and the figure-eight uses a Bezier approximation of a Lissajous curve.
Both use Bezier vertical profiles.
GPS, optical flow, magnetometer, and barometer aiding are disabled by the upstream mocap navigation mode.

| Scenario              | Route                                                                       | Duration |
| --------------------- | --------------------------------------------------------------------------- | -------- |
| `qualification-mocap` | Original qualification geometry: takeoff, 4 m box at 2 m, landing           | 45 s     |
| `circles-mocap`       | Takeoff to 2 m, two 3 m-radius Dubins circles at 2 m/s, landing             | 40 s     |
| `figure-eight-mocap`  | Takeoff to 2 m, 12 by 6 m Lissajous figure-eight at up to 8.25 m/s, landing | 25 s     |

From the repository root:

```sh
nix develop
rdd2-simulate scenarios/rumoca-scenario.qualification-mocap.toml
rdd2-simulate scenarios/rumoca-scenario.circles-mocap.toml
rdd2-simulate scenarios/rumoca-scenario.figure-eight-mocap.toml
```

The pinned model fork includes trajectory rate and acceleration feedforward for improved tracking.
No sibling checkout is required. For local library edits, use `--modelica-root ../modelica_models`.
The Python tool and service keep feedforward connections supported by the selected controller and ignore
missing jerk, snap, yaw-rate, or yaw-acceleration inputs. Position, velocity, acceleration, and yaw remain
connected; all planned derivatives remain available in the mission reference. This compatibility step uses
a temporary source copy. Direct Rumoca commands require the controller inputs declared by the mission files.
Scenario edits apply to the next run without re-entering `nix develop`. The local service discovers all missions;
restart it after adding new scenario files.

Logs default to `exports/<scenario-name>/trace.arrow`; override with `--out PATH`.
Commanded position/velocity references are included for path and tracking comparisons.
Successful runs replace existing logs; use `--out` with a different directory to keep each run.

## Dubins circles

`CircleMission.mo` defines one explicit left-turn `Planning.Dubins.Path` spanning both revolutions around the ENU
center `{0, 3, 2}` m. This preserves the full looping arc; shortest-path search between identical poses would not
enforce the laps. Its nested `DubinsCircleTrajectory` block evaluates the Dubins arc directly, producing an exact
circular reference with position, velocity, acceleration, jerk, and snap. Drone yaw points inward toward the
circle center, 90 degrees left of the tangent. It turns smoothly into that heading during takeoff, stays
unwrapped across both laps, and holds its final heading during landing. The speed ramps also smoothly start
and stop the commanded turn rate.

The circle reaches 2 m/s after a 2 s smooth speed ramp and brakes over another 2 s before landing. The ramps
are included in the two-lap arc distance; the circle phase takes approximately 20.85 s. There is no waypoint
duration floor limiting circle speed. `pointsPerCircle` controls display samples only.

Vertical motion uses rest-to-rest septic Bezier segments with independent durations: 3 s to climb to 2 m, 3 s to
descend to 0.3 m, and 1 s to reach the 0.1 m touchdown reference. Circle speed does not shorten these segments.
The full route takes approximately 27.85 s; arming starts at 1 s and the standard disarm delay is 3 s.
The simulation ends at 40 s, approximately 8.15 s after scheduled disarm at 31.85 s.
Its nested `DubinsCircleAvionics` block feeds these references into the existing controller and retains manual
position-mode selection and mission-clock pause behavior. All Modelica additions are in `CircleMission.mo`.

`radius_m`, `revolutions`, `cruiseAltitude_m`, `cruiseSpeed_m_s`, `speedRampDuration_s`, `takeoffDuration_s`,
`descentDuration_s`, and `touchdownDuration_s` configure the mission. The arc must be long enough for both speed
ramps. For future timing or route changes, choose a round simulation end time at least 5 s after
`armTime_s + trajectoryDuration + disarmDelay_s`; update both TOML `t_end` and Modelica `StopTime`.

Focused trajectory tests check reference geometry and timing; they do not establish closed-loop flight performance.
This Dubins mission has not been validated with a full vehicle simulation.

`--stop-time 0.05` is useful for a startup smoke run; it does not validate the completed flight.

## Lissajous figure-eight

`FigureEightMission.mo` keeps the geometry, timing, and controller wiring in one file. It takes off from the
origin to 2 m, flies a Bezier approximation of `x = 6 sin(theta)`, `y = 3 sin(2 theta)` for one loop, then lands
at the origin. Eight degree-nine segments match position and phase derivatives through snap at their
joins. The default approximation differs from the ideal 12 by 6 m curve by less than one micrometre.
The existing Bezier evaluator supplies spatial derivatives through fourth order; a Bezier phase ramp and
the chain rule convert them to physical-time velocity, acceleration, jerk, and snap. Yaw follows the
approximated curve's tangent. Display waypoints sample the ideal curve.

Two-second entry and exit ramps surround constant phase rate. Physical speed varies along the curve and
reaches **8.25 m/s at the interior crossing**, with no crossing slowdown. Average horizontal speed, including
the ramps, is approximately 4.32 m/s. Yaw turns smoothly to the initial 45-degree tangent during takeoff,
follows travel through both lobes without angle jumps, and holds that heading for landing.

The peak speed is about 8% below an estimated 8.93 m/s actuator boundary. At the default speed, nominal
reference thrust peaks near 31.07 N (31.62 N with a drag allowance) against 41.37 N collective capacity.
Yaw moment including rate damping peaks near 0.244 Nm against the 0.30 Nm cap; the most loaded rotor reaches
about 90% of its maximum thrust. These estimates include rigid-body coupling and nominal motor allocation;
they do not establish tracking with motor lag, estimation errors, or disturbances.

Vertical durations remain 3 s for takeoff, 3 s for descent to 0.3 m, and 1 s to the 0.1 m touchdown reference.
The route takes approximately 15.46 s, with scheduled disarm at 19.46 s. The round 25 s end time leaves
approximately 5.54 s after disarm, including margin for the 20 ms mission clock.

`longitudinalAmplitude_m`, `lateralAmplitude_m`, `cruiseAltitude_m`, `cruiseSpeed_m_s` (peak crossing speed),
`speedRampDuration_s`, and the vertical durations configure the mission. Recheck feasibility after changing
geometry or speed. Retain at least 5 s after scheduled disarm in both TOML and Modelica end times.

Controllers without the extra feedforward can run the same mission, but these reference estimates do not
establish their tracking performance at the selected speed.

Focused reference tests check shape, tangent yaw, derivative continuity, crossing speed, and full reference
body moments and individual rotor demands. They do not run a full vehicle flight.
