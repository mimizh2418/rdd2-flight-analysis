# Graph view

Each graph tab contains one time-series plot with a shared time X axis and independent left/right Y axes.
Drag scalar fields into either dock lane. Vectors, poses, motor commands, and rotor arrays expand into separate scalar
bindings with different colors; each component can then be styled, hidden, or moved independently.

## Axes and appearance

Each Y axis accepts one compatible unit family. Put a different quantity on the other axis or another graph tab;
for example, position on the left and velocity on the right. Static mission geometry cannot be graphed because it has no
time axis.

Open a field's preview icon for preset colors, solid/dashed/dotted strokes, line weight, markers, and axis assignment.
Axis controls offer automatic scaling, inclusion of zero, or manual limits. Automatic limits fit the visible data,
so zooming into a maneuver also updates the Y range. Angle units are in the top-level settings menu.

| Signal kind | Drawing and sampling                                                       |
| ----------- | -------------------------------------------------------------------------- |
| Continuous  | Straight connections between samples and linear interpolation for readouts |
| Held        | Steps that retain the previous value until the next update                 |
| Event       | Markers at event timestamps without a connecting line                      |

“Smooth” continuous lines do not apply a smoothing filter. The signal kind determines interpolation; dashed/dotted styles
only change appearance. Missing values and detected long gaps break lines.

## Navigate and inspect

| Gesture                                | Action                                 |
| -------------------------------------- | -------------------------------------- |
| Wheel/pinch                            | Zoom time around the pointer           |
| Drag                                   | Zoom to the selected time interval     |
| Shift-drag / horizontal or Shift-wheel | Pan time                               |
| Hover while paused                     | Preview values at pointer time         |
| Click                                  | Pause playback and commit pointer time |

The graph's time axis replaces the separate 3D timeline. During playback, hover still shows a pointer cursor without
changing displayed telemetry. Time navigation remains synchronized across tabs.

Enable **Select interval** in settings to make a drag select the analysis/export interval instead of zooming.
That interval is independent of the visible time window.

The plot reuses prepared indices during navigation and samples to a display budget, retaining extrema and gaps.
Raw data stays at full resolution for statistics and [exports](../playback-and-workspaces.md#export).
