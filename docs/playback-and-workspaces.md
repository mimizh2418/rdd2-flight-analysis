# Playback and workspaces

## Shared time

All tabs share the committed timestamp, play/pause state, speed, alignment, and visible time window.
The 3D views have a timeline above the scene; graph tabs use their time X axis instead.

| Interaction          | Result                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| Paused hover         | Preview data at pointer time; leaving restores the committed timestamp |
| Running hover        | Show pointer time/cursor while telemetry continues following playback  |
| Click timeline/graph | Pause and seek to the clicked time                                     |
| Wheel/pinch          | Zoom around pointer time                                               |
| Drag timeline        | Pan the visible interval                                               |
| Shift-drag graph     | Pan; an ordinary graph drag zooms or selects an analysis interval      |

The hover readout is the pointer's timestamp in seconds. It remains visible when zooming/panning.
**Auto-scroll** continuously moves the window as playback approaches its right edge. **Loop** repeats playback;
both are in the top-level settings menu.

On the focused timeline, arrow keys step between samples, Home/End seek to the coverage endpoints, and +/− zoom.

## Comparing logs

Choose absolute time, alignment to armed, or alignment to mission start in settings. Event alignment subtracts each
run's event time from its display clock; original timestamps remain unchanged. A run missing the selected event is
unavailable in that alignment and produces a warning. Choose another alignment to inspect it.

Values follow the signal's continuous/held/event semantics and validity. Outside coverage or across long gaps,
readouts are unavailable rather than extrapolated.

## Save and restore

Use the workspace menu to save/load JSON layouts. Browser storage also retains the layout locally.
`rdd2-workspace-v1` stores tabs, field appearance, camera options, time/window, alignment, panel sizes, and log identities.
It does **not** store telemetry arrays. Reimport the original logs to reconnect their bindings; matching uses file
fingerprints, not just filenames. Each tab's bindings remain independent.

## Export

Open **Export**, select a source run and interval, then choose Arrow, CSV, or statistics JSON.
By default, log export includes all original source channels. Uncheck that option to export the selected run's fields
from the active tab instead.
Graph **Select interval** mode lets a drag set the interval, independently of zoom.

Arrow/CSV export includes original rows inside the inclusive interval, retaining event rows and gaps.
It does not resample or invent endpoint rows. Display alignment is translated back to the run's original simulation time.
Arrow embeds metadata and selection provenance, including the source file hash; CSV is the secondary interchange option.

Statistics use full-resolution data and report interval, alignment, coverage, and time-weighted metrics. Plot decimation
and the visible zoom window do not change the selected analysis interval.
