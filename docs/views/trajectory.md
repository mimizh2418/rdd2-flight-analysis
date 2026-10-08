# Trajectory view

Use this view to compare actual, estimated, and reference motion in world ENU coordinates, including multiple logs.

## Add and configure fields

Drag a pose, position, mission path, orientation, or velocity into **3D fields**. Position-bearing fields have a
**Trajectory / Pose / Both** selector on their dock row; paths and poses do not need separate bindings.

| Appearance option               | Effect                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Color, line style, weight       | Independent trajectory styling with preset colors and solid/dashed/dotted strokes |
| Full path                       | Show the complete path rather than only the traveled portion                      |
| Model, color, scale             | Drone, ghost drone, or ball marker                                                |
| Orientation                     | Native attitude, no attitude, or an orientation field from an imported log        |
| Vector scale, frame, components | Configure velocity arrows in ENU/FLU and optionally show their components         |
| Attach                          | Anchor a velocity/orientation layer to a pose or the world origin                 |

Use the appearance preview icon to open these settings. A position without attitude can still show a marker;
the app does not infer its orientation. Reference positions can use exported reference yaw.

An **Intended mission path** field appears when mission geometry is embedded. A recorded reference position is a separate
time-dependent field, so both can be displayed together. Invalid values and long gaps break paths.

## Camera and playback

**Fit**, **Orbit**, **Top**, and **Side** controls sit inside the view. **Follow** centers the camera on a selected visible
pose/position while retaining orbit and zoom; choose its target beside the other camera controls. This follows position.
For a camera that rotates with body attitude, use the [vehicle view](vehicle.md).

The timeline above the scene shares its clock and visible interval with all other tabs. See
[playback controls](../playback-and-workspaces.md). Hiding a field keeps its configuration; removing a follow target
returns to orbit control at the last viewpoint.
