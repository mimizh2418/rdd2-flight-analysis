# RDD2 scenarios

All missions extend `Vehicles.Rdd2.WaypointVehicleSystem` directly and use its plant, noisy sensors, mocap-aided
estimator (`navigationSource = 3`, `fuseMocap = true`), and standard guidance/rate control. Qualification uses the
upstream waypoint planner; circles and the figure-eight use mission-local Dubins references with Bezier vertical profiles.
GPS, optical flow, magnetometer, and barometer aiding are disabled by the upstream mocap navigation mode.

| Scenario              | Route                                                                              | Duration |
| --------------------- | ---------------------------------------------------------------------------------- | -------- |
| `qualification-mocap` | Original qualification geometry: takeoff, 4 m box at 2 m, landing                  | 45 s     |
| `circles-mocap`       | Takeoff to 2 m, two 3 m-radius Dubins circles at 2 m/s, landing                    | 40 s     |
| `figure-eight-mocap`  | Takeoff to 2 m, 3 m-radius Dubins lobes at 2.5 m/s with a smooth crossing, landing | 35 s     |

From the repository root:

```sh
nix develop
rdd2-simulate scenarios/rumoca-scenario.qualification-mocap.toml
rdd2-simulate scenarios/rumoca-scenario.circles-mocap.toml
rdd2-simulate scenarios/rumoca-scenario.figure-eight-mocap.toml
```

The pinned model fork includes the trajectory rate and acceleration feedforward needed by these missions.
No sibling checkout is required. For local library edits, use `--modelica-root ../modelica_models`.
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

## Dubins figure-eight

`FigureEightMission.mo` keeps the figure-eight geometry, timing, and controller wiring in one Modelica file.
It takes off from the origin to 2 m, flies one left lobe centered at `{0, 3, 2}` m and one right lobe centered
at `{0, -3, 2}` m, then returns to the origin for landing. Yaw follows the direction of travel.

The lobes are explicit `Planning.Dubins.Path` arcs evaluated with `Planning.Dubins.advance`. A septic Bezier
bridge replaces the last 0.5 rad of the left circle and the first 0.5 rad of the right circle. It matches
position, velocity, acceleration, and jerk at both joins, smoothing the curvature reversal while maintaining
forward flight through the origin. Crossing speed stays at least 2.5 m/s and briefly reaches about 2.62 m/s;
there is no crossing slowdown or hover. The displayed waypoint rows sample the nominal Dubins circles.

Two-second entry and exit ramps surround 2.5 m/s cruise. Vertical durations remain 3 s for takeoff, 3 s for
descent to 0.3 m, and 1 s to the 0.1 m touchdown reference. The route takes approximately 24.06 s, with
scheduled disarm at 28.06 s. The round 35 s end time leaves approximately 6.94 s after disarm.

`radius_m`, `cruiseAltitude_m`, `cruiseSpeed_m_s`, `speedRampDuration_s`, `crossingBlendAngle_rad`, and the
vertical durations configure the mission. Changing speed also scales the crossing duration. Retain at least
5 s after scheduled disarm when changing either the TOML or Modelica end time.

Focused reference tests check geometry, tangent yaw, derivative continuity, crossing speed, and reference
thrust/yaw-moment estimates against the RDD2 limits. A short startup check covers runtime initialization;
these checks do not establish closed-loop flight performance.
