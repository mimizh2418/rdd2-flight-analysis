# Generate simulation logs

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and check out
[modelica_models](https://github.com/CogniPilot/modelica_models) beside this repository.
The npm shortcuts select locked Python dependencies automatically; no environment activation is required.
The simulation extra provides Rumoca 0.10.2 with its compiler and solver, so a separate Rumoca CLI is unnecessary.

## Run a scenario

```sh
npm run simulate -- \
  ../modelica_models/Vehicles/Rdd2/Test/rumoca-scenario.waypoint-global.toml \
  --out exports/rdd2
```

Import `exports/rdd2/trace.arrow` into the viewer. Simulation writes numeric columns directly to Arrow without an
intermediate CSV. Use a new or empty output directory; existing artifacts are not overwritten.

| Option                 | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `--modelica-root PATH` | Model checkout; defaults to `../modelica_models`                    |
| `--stop-time SECONDS`  | Override the scenario duration with a positive finite value         |
| `--mission-json PATH`  | Attach resolved mission geometry; it is not extracted automatically |
| `--name NAME`          | Display name for the log                                            |
| `--format csv`         | Write `trace.csv` plus `manifest.json` instead of Arrow             |
| `--quiet`              | Suppress progress on stderr                                         |

For mission geometry, the JSON object can contain `waypoints`, `trajectory`, `origin`, `rotor_positions`, and `ground`;
see the [format guide](arrow-format.md). Use `npm run simulate -- --help` for the current CLI options.

## Progress and provenance

The tool reports setup, source hashing, model loading, simulation, extraction, validation, writing, and publication.
Long model-loading/simulation stages emit elapsed-time heartbeats; these are not solver completion percentages.
Arrow writing reports row progress. Stdout from the Python tool contains the completed output directory.

Metadata records source identity, solver settings, observed coverage, timing information, and Rumoca package/native
versions plus the native extension hash. Source checks before/after the run detect input changes.
Logs ending before the requested duration are marked partial. Output is staged privately and published after completion;
failure removes the staging output.

## Convert existing CSV

```sh
npm run convert:csv -- existing.csv --out exports/converted
```

This secondary command does not simulate and needs no Rumoca dependency. Add `--receipt manifest.json` to verify and
preserve a matching CSV provenance receipt. Without a receipt, conversion does not establish simulation provenance.
Shared options such as `--name`, `--mission-json`, and `--format` are also accepted.

## Local service

```sh
npm run service
```

Connect the app's **Simulation** panel to `http://127.0.0.1:8765`, choose a discovered scenario, and submit a job.
The service runs one simulation at a time, supports status polling/cancellation, and imports a completed artifact.
It discovers `Vehicles/Rdd2/Test/rumoca-scenario.*.toml` under the configured checkout.
This is batch execution followed by log import; telemetry is not streamed while the solver runs.

Run `npm run service -- --help` for checkout, artifact-directory, and port options.
Implementation: [CLI](../tools/rdd2_simulate.py), [simulation modules](../tools/rdd2_simulation/),
[service](../tools/simulation_service.py).
