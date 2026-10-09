# Generate simulation logs

Enter the [Nix environment](nix.md) with `nix develop` before running these commands from the repository root.
It supplies uv, Python, pinned model sources, and the `rdd2-*` shortcuts. uv selects locked Python dependencies
automatically; no virtual environment activation is required. See [setup without Nix](nix.md#without-nix) for the alternative.
The simulation extra provides Rumoca 0.10.2 with its compiler and solver, so a separate Rumoca CLI is unnecessary.

## Run a scenario

```sh
rdd2-simulate scenarios/rumoca-scenario.qualification-mocap.toml
```

Output defaults to `exports/<scenario-name>/`, relative to the working directory, stripping `rumoca-scenario` and
its separator from the filename stem. A bare `rumoca-scenario.toml` uses `exports/scenario/`.
Import `exports/qualification-mocap/trace.arrow` into the viewer. Simulation writes directly to Arrow without an
intermediate CSV. Successful runs replace existing logs in the output directory; failed simulations keep the previous logs.
Switching formats removes stale Arrow/CSV artifacts. Unrelated files are preserved. Use `--out` to keep runs separately.

The model root comes from `RDD2_MODELICA_ROOT`, so no sibling checkout is needed.
To use a modified checkout instead, pass `--modelica-root ../modelica_models`. This controls Rumoca's compiler roots,
not just provenance. Project scenarios always use the local working-tree sources.
Scenario TOML files can be anywhere: pass an absolute path, `~/...`, or a path relative to the working directory.
Library-relative paths still work. `[model].file` resolves relative to the TOML file, or can be an absolute path.

[Project scenarios](../scenarios/README.md) include the qualification box and two approximate 3 m-radius circles,
both using mocap and the upstream waypoint planner.

| Option                 | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `--out PATH`           | Override the default export directory                                   |
| `--modelica-root PATH` | Model sources; defaults to `RDD2_MODELICA_ROOT` or `../modelica_models` |
| `--stop-time SECONDS`  | Override the scenario duration with a positive finite value             |
| `--mission-json PATH`  | Attach resolved mission geometry; it is not extracted automatically     |
| `--name NAME`          | Display name for the log                                                |
| `--format csv`         | Write `trace.csv` plus `manifest.json` instead of Arrow                 |
| `--quiet`              | Suppress progress on stderr                                             |

For mission geometry, the JSON object can contain `waypoints`, `trajectory`, `origin`, `rotor_positions`, and `ground`;
see the [format guide](arrow-format.md). Use `rdd2-simulate --help` for the current CLI options.

## Progress and provenance

The tool reports setup, source hashing, model loading, simulation, extraction, validation, writing, and publication.
Long model-loading/simulation stages emit elapsed-time heartbeats; these are not solver completion percentages.
Arrow writing reports row progress. Stdout from the Python tool contains the completed output directory.

Metadata records source identity, solver settings, observed coverage, timing information, and Rumoca package/native
versions plus the native extension hash. Source checks before/after the run detect input changes.
External scenario sources are fingerprinted in `scenario_sources`; a separately located model package is recorded in
`model_sources`. Both are included in the combined source digest.
Logs ending before the requested duration are marked partial.

Temporary `.scenario-export-*` directories under `exports/` hold unpublished files on the same filesystem as the
destination, allowing fast renames instead of copying large logs. The final directory is created only for publication.
Failures remove staging and newly created empty directories; publication errors restore previous artifacts.
The CLI supervises native work in a child process, so cleanup also handles Rumoca crashes and cancellation.
Force-killing the supervising process or losing power can still leave staging directories. Compiler/dependency caches
are outside this export rollback.

## Convert existing CSV

```sh
rdd2-convert-csv existing.csv --out exports/converted
```

This secondary command does not simulate and needs no Rumoca dependency. Add `--receipt manifest.json` to verify and
preserve a matching CSV provenance receipt. Without a receipt, conversion does not establish simulation provenance.
Shared options such as `--name`, `--mission-json`, and `--format` are also accepted.

## Local service

```sh
rdd2-service
```

Connect the app's **Simulation** panel to `http://127.0.0.1:8765`, choose a discovered scenario, and submit a job.
The service runs one simulation at a time, supports status polling/cancellation, and imports a completed artifact.
It discovers local `scenarios/rumoca-scenario.*.toml` and upstream `Vehicles/Rdd2/Test/rumoca-scenario.*.toml`
under the configured model library. Edits to existing files apply to the next job; restart the service to discover new files.
This is batch execution followed by log import; telemetry is not streamed while the solver runs.

Run `rdd2-service --help` for checkout, artifact-directory, and port options.
Implementation: [CLI](../tools/rdd2_simulate.py), [simulation modules](../tools/rdd2_simulation/),
[service](../tools/simulation_service.py).
