# Documentation

These guides describe the implemented application. Setup, build/test commands, and planned features are in the
[project README](../README.md).

## Workflow

1. Import an Arrow log or a CSV with its optional manifest; repeat to compare runs.
2. Create a visualization tab and search the field browser. Expand vectors and poses to select individual components.
3. Drag a compatible field into the bottom dock, or use its add menu. A progress bar shows field preparation.
4. Configure appearance through the field's preview icon. The eye toggles visibility; × removes the binding.
5. Use the shared clock to inspect data, then save the workspace or export a selected interval.

Field values follow the displayed timestamp. Each tab keeps its own fields and appearance settings; logs and playback
are shared. Scalar values show up to six decimal places. Source names appear beside dock fields when multiple logs are open.

## Guides

| Topic                                                | Guide                                                 |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Log schema and metadata                              | [Arrow format](arrow-format.md)                       |
| Recognized signals, units, and calculations          | [Data and diagnostics](data-and-diagnostics.md)       |
| Paths, poses, and camera following                   | [Trajectory view](views/trajectory.md)                |
| Time-series plots and two Y axes                     | [Graph view](views/graph.md)                          |
| Attitude and actuation overlays                      | [Vehicle view](views/vehicle.md)                      |
| Time alignment, export, and saved layouts            | [Playback and workspaces](playback-and-workspaces.md) |
| Generate logs and run the local service              | [Simulation tool](simulation-tool.md)                 |
| Pinned development environment and command shortcuts | [Nix tooling](nix.md)                                 |
| Modules, workers, and validation                     | [Architecture](architecture.md)                       |
