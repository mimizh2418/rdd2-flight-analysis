# RDD2 scenarios

Both missions extend `Vehicles.Rdd2.WaypointVehicleSystem` directly. They use its existing avionics, septic Bezier
waypoint planner, guidance, rate control, noisy sensors, and mocap-aided estimator (`navigationSource = 3`, `fuseMocap = true`).
GPS, optical flow, magnetometer, and barometer aiding are disabled by the upstream mocap navigation mode.

| Scenario              | Route                                                             | Duration |
| --------------------- | ----------------------------------------------------------------- | -------- |
| `qualification-mocap` | Original qualification geometry: takeoff, 4 m box at 2 m, landing | 45 s     |
| `circles-mocap`       | Takeoff to 2 m, five 3 m-radius circles, landing                  | 110 s    |

From the repository root:

```sh
nix develop
rdd2-simulate scenarios/rumoca-scenario.qualification-mocap.toml
rdd2-simulate scenarios/rumoca-scenario.circles-mocap.toml
```

Scenarios run directly from this working tree against the pinned model library. Edits apply to the next run without
re-entering `nix develop`. The local service discovers both missions; restart it after adding new scenario files.
For a developer checkout, add `--modelica-root ../modelica_models`; project sources run against it without copying.

Logs default to `exports/qualification-mocap/trace.arrow` and `exports/circles-mocap/trace.arrow`; override with `--out PATH`.
Commanded position/velocity references are included for path and tracking comparisons.
Use an empty output directory; completed logs are never overwritten.

## Circle approximation

`CircleMission.mo` samples 16 points per lap around the ENU center `{0, 3, 2}` m, with all five laps in one plan.
The route starts and ends above the initial position. Tangential waypoint velocities keep the vehicle moving between
samples and across lap joins; the first and last circle velocities are zero for takeoff/landing. Heading stays at zero.

The existing planner interpolates these points with septic Bezier segments, so the path approximates a circle between
waypoints. `radius_m`, `revolutions`, `pointsPerCircle`, `cruiseAltitude_m`, and `cruiseSpeed_m_s` configure the route.
If changing route length or speed, increase TOML `t_end` to cover `armTime_s + trajectoryDuration + disarmDelay_s`.

`--stop-time 0.05` is useful for a startup smoke run; it does not validate the completed flight.
