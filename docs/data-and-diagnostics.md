# Data and diagnostics

The importer retains raw numeric columns and recognizes RDD2 truth, estimator, reference, feedback, actuation, and status
channels. Known Modelica names and unique qualified suffixes map to canonical signals; ambiguous suffixes are rejected.
Generic numeric logs can still be graphed without supplying RDD2 channels.

The field browser groups poses, vectors, arrays, and their scalar components. Derived diagnostics appear only when their
dependencies exist. [Normalization](../src/data/normalize.ts) defines recognition and calculations;
[field catalog](../src/workspace/fieldCatalog.ts) defines browser grouping.

## Conventions and missing data

- World vectors use **ENU**: East, North, Up. Body vectors use **FLU**: Forward, Left, Up.
- Position is in meters, velocity in m/s, acceleration in m/s², and stored angles/rates in radians or rad/s.
- Source quaternions use `w,x,y,z`; the renderer uses `x,y,z,w` internally. Roll/pitch/yaw use the ZYX convention.
- Angle display is selectable per tab. Body angular velocity is **p, q, r**, not the derivatives of Euler angles.
- Continuous signals interpolate linearly, held signals retain the left value, and event signals exist at their timestamp.

Validity channels must exceed 0.5. When reference/estimate validity is absent, finite vector components supply a fallback
and the run carries a warning. Raw channels remain inspectable. Missing values, invalid states, and long gaps are not
bridged in playback or analysis; unavailable values display as `—`. A long gap exceeds
`max(0.05 s, 20 × median distinct sample interval)` for the run.

## Calculated fields

Let `p` and `v` denote truth position and velocity, `p_ref`/`v_ref` the reference, and `p_est`/`v_est` the estimator.
Errors use ENU components; vector norms and horizontal norms are available where supported.

| Diagnostic                           | Calculation / required data                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Velocity / acceleration fallback     | Centered differences over distinct valid timestamps when native channels are absent; endpoints/gaps remain unavailable |
| Speed / ground speed                 | `norm(v)` / `hypot(vEast, vNorth)`                                                                                     |
| Position tracking error              | `p − p_ref`, with a valid reference                                                                                    |
| Position estimation error            | `p_est − p`, with a valid estimate                                                                                     |
| Velocity tracking / estimation error | `v − v_ref` / `v_est − v`, with corresponding validity                                                                 |
| Distance traveled                    | Sum of valid consecutive truth-position increments; gaps break connectivity                                            |
| Nearest-path distance                | Minimum distance to the complete recorded reference polyline; also available in the horizontal plane                   |
| Along-track error                    | `dot(p − p_ref, v_ref / norm(v_ref))`                                                                                  |
| Signed lateral error                 | `(-vNorth × errorEast + vEast × errorNorth) / horizontalReferenceSpeed`; positive to the left of reference motion      |
| Heading tracking error               | Wrapped `yaw − referenceYaw`                                                                                           |
| Tilt                                 | `acos(R33)` from truth attitude                                                                                        |
| Attitude estimation error            | `2 × acos(abs(dot(q, q_est)))` using normalized quaternions                                                            |

Along-track/lateral errors require reference motion above `1e-5` m/s. Nearest-path distance ignores timing and uses
**recorded reference data**, not a future mission plan. Mission restarts, sequence changes, invalid references, and gaps
break reference segments.

## Estimator diagnostics and statistics

When the required covariance, estimate, and truth channels are present, the viewer exposes position/velocity uncertainty
bounds `±1.96σ` around zero for comparison with estimation errors. Covariance is transformed into ENU for these bounds;
they represent modeled uncertainty, not absolute bounds around the estimated state.

Six-state NEES uses position and velocity errors with the full covariance: `eᵀ P⁻¹ e`, evaluated in the covariance's
frame. NIS uses the exported innovation statistic, split by attempted correction source (mocap, GPS, optical flow,
magnetometer, barometer). These diagnostics use native estimator ticks rather than counting repeated held values as
new samples. Missing/invalid inputs do not produce invented statistics.

Interval reports use full-resolution, time-weighted calculations, including mean, RMS, maximum, coverage, and a p95
estimate based on interval midpoints. Duplicate event rows add no duration. Display decimation does not affect reports.
