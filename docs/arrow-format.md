# Arrow log format

The primary log is a self-contained, uncompressed **Arrow IPC file** (`.arrow`), with MIME type
`application/vnd.apache.arrow.file`. It contains numeric telemetry and embedded JSON metadata. IPC streams are not accepted.

## Columns and time

| Requirement       | Behavior                                                                          |
| ----------------- | --------------------------------------------------------------------------------- |
| Columns           | Unique, nonempty names; every column is Float64 and has the same row count        |
| Time              | Nonempty, finite, nondecreasing `time` or `time_s`, in seconds                    |
| Both time columns | Accepted only when corresponding timestamps agree within event tolerance          |
| Vectors/arrays    | Flat component columns, such as `position_m[1]`, `position_m[2]`, `position_m[3]` |
| Missing telemetry | NaN/nonfinite values become visualization gaps; imported Arrow nulls become NaN   |
| Events            | Duplicate and near-coincident timestamps retain all original rows and their order |

Playback uses the final row of each coincident event group. The tolerance is
`8 × Number.EPSILON × max(1, |a|, |b|)`; interpolation respects event boundaries and detected gaps.
Raw event rows remain available for export. Input is never sorted or resampled to repair invalid time.

The Python writer uses record batches of at most 65,536 rows. Batch boundaries have no simulation meaning.
The browser joins batches when contiguous column arrays are needed; importing still loads the log into memory.

## Embedded metadata

| Location/key            | Contents                                                               |
| ----------------------- | ---------------------------------------------------------------------- |
| Schema: `rdd2:format`   | `rdd2-arrow-v1`                                                        |
| Schema: `rdd2:manifest` | JSON object with `schema: "rdd2-viewer-v1"`                            |
| Field: `rdd2:signal`    | Optional JSON annotation: `label`, `unit`, `frame`, `kind`, `validity` |

Manifest signal annotations take precedence over field annotations. Signal kinds are `continuous`, `held`, or `event`;
`validity` names a channel that must exceed 0.5 for the signal to be usable.

A minimal manifest might contain:

```json
{
  "schema": "rdd2-viewer-v1",
  "name": "Waypoint flight",
  "world_frame": "ENU",
  "body_frame": "FLU",
  "quaternion_order": "wxyz",
  "signals": {
    "position_m[1]": { "unit": "m", "frame": "ENU", "kind": "continuous" }
  }
}
```

Optional metadata records model/scenario identity, solver settings, compiler versions, source hashes, timings, and
observed coverage. `mission` can carry ENU `waypoints`/`trajectory`, an `origin`, body-frame `rotor_positions`, and a
`ground` plane (`normal`, `offset`). Mission geometry must be supplied; it is not inferred from the scenario.

The importer also accepts generic Float64 IPC files without RDD2 metadata and infers available fields.
An explicit unsupported format version, missing required manifest, incompatible coordinate convention, or malformed
consumed metadata is rejected. See the [codec](../src/data/arrow.ts) and [manifest types](../src/data/types.ts).

## Integrity and CSV compatibility

The browser hashes the imported file for workspace matching. Arrow metadata does not embed a checksum of its own complete
file and must not contain `csv` or `csv_sha256`. Simulation provenance and file identity serve different purposes.

CSV remains a secondary format: numeric columns plus optional `manifest.json`, whose CSV checksum is verified when
provided. Conversion preserves receipt provenance and records the source CSV hash inside the Arrow manifest.
See [simulation commands](simulation-tool.md) and [selection export](playback-and-workspaces.md#export).
