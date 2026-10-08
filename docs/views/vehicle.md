# Vehicle view

Use this view for attitude and actuation inspection without following the flight through world space.
The drone stays centered; there is no ground grid.

## Vehicle and camera

Drop a pose, position, or orientation into **Vehicle**. Its appearance menu offers the same drone, ghost drone, ball,
color, scale, and orientation choices as the [trajectory view](trajectory.md). Position alone does not provide attitude.

**Follow orientation** rotates the camera with the drone, keeping its body stable on screen. When disabled, a world-fixed
camera shows the drone rotating. Body/world axes can be toggled independently. Fit, orbit, top, and side controls remain
available. Roll/pitch/yaw readouts use the selected attitude and the tab's angle units.

## Overlays

Drag supported fields into **Overlays**, then use their appearance menus for color and display scaling.

| Field                       | Visualization / meaning                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Velocity                    | Vector arrow, optional component arrows, configurable ENU/FLU frame and scale        |
| Orientation                 | Attitude overlay/readouts                                                            |
| Motor effort commands       | Per-rotor command indicators; dimensionless effort                                   |
| Actual rotor speeds         | Per-rotor speed indicators in rad/s                                                  |
| Collective thrust command   | Command indicator; not a measurement of individual rotor thrust                      |
| Supported scalar components | Individual velocity, attitude/body-rate, motor, rotor, or thrust readouts/indicators |

Motor effort and rotor speed are displayed with visual scales, not converted into physical rotor thrust.
Rotor indicators use supplied body-frame rotor positions when present, otherwise nominal geometry.
Unavailable channels remain unavailable; adding an overlay does not reconstruct actuator measurements.

The timeline and playback behavior are shared with the other views; see
[playback and workspaces](../playback-and-workspaces.md).
