# RDD2 Flight Analysis

A browser application for replaying and comparing RDD2 drone simulations from
[modelica_models](https://github.com/CogniPilot/modelica_models) and
[Rumoca](https://github.com/CogniPilot/rumoca). Logs are processed locally in your browser.

Built with AI slop because I don't have time to do it properly.

## Features

- **3D replay:** compare trajectories and poses, or inspect a centered vehicle's attitude, velocity, and motor effort.
- **Telemetry graphs:** configurable signals and styles, dual Y axes, zoom, and automatic scaling.
- **Diagnostics:** tracking errors, path deviation, and estimator uncertainty when the necessary channels are present.
- **Comparison and export:** synchronized logs and tabs, event alignment, saved workspaces, and Arrow/CSV/statistics export.
- **Live simulation (planned):** run RDD2 simulations in-browser with Rumoca WebAssembly, live 3D/telemetry updates,
  and recording for later analysis. Rumoca and `modelica_models` will be pinned and packaged through Nix.

## Getting started

Requires **Node.js 22.12+** and npm. The 3D views also require WebGL.

```sh
npm ci
npm run dev
```

Import a `.arrow` log with embedded simulation metadata and mission geometry. CSV remains supported with a `time`
or `time_s` column in seconds and an optional matching `manifest.json` for hash verification and provenance.
RDD2 channels are recognized automatically; other numeric columns remain available as raw signals.

Shift-drag pans graphs. Paused hover previews data without seeking. Saved workspaces contain settings;
reimport the original logs to restore their data.

Coordinates use East-North-Up (world) and Forward-Left-Up (body). Thrust is a collective command, not measured rotor thrust.

## Generating logs (optional)

Existing logs need no Python environment. For Python tooling, install [uv](https://docs.astral.sh/uv/getting-started/installation/).
It manages Python, creates `.venv`, and installs dependencies from `uv.lock`; activation is unnecessary.
`uv run --locked` prepares the environment automatically when running a command.

To convert an existing CSV to Arrow:

```sh
uv run --locked tools/export_rdd2_viewer.py --csv existing.csv --out exports/flight
```

To simulate, install the **Rumoca 0.10.2 CLI** and check out `modelica_models` beside this repository.
The `simulation` extra installs matching Python bindings:

```sh
uv run --locked --extra simulation tools/export_rdd2_viewer.py \
  --scenario ../modelica_models/Vehicles/Rdd2/Test/rumoca-scenario.waypoint-global.toml \
  --out exports/rdd2
```

Import the resulting `trace.arrow`; its metadata is embedded, so no sidecar is needed. Add `--format csv` to produce
`trace.csv` and `manifest.json` instead. See `--help` for checkout locations, receipts, and mission geometry.

The exporter reports stages, elapsed time, and write progress on stderr; `--quiet` suppresses these messages.
Metadata records model-loading and simulation timings; final write/publication timings appear on stderr.
Stdout contains the final output directory.

For batch simulations from the app, run `npm run service` and connect **Simulation** to `http://127.0.0.1:8765`.

## Build and test

```sh
npm run build                         # Type-check and build into dist/
npm test                              # Data and numerical tests
npm run test:python                   # uv installs the Python environment; Rumoca not required
npx playwright install chromium       # One-time browser setup
RDD2_PREVIEW=1 npm run test:browser    # Browser tests against the production build
```

`npm run preview` serves the build. Browser tests start their own server; set `RDD2_GPS_TRACE` to a qualification CSV
or `RDD2_RUMOCA_BUNDLE` to a bundle directory to include optional artifact tests.

Tests are grouped by behavior in [tests/core](tests/core/) and [tests/browser](tests/browser/), with shared fixtures
and actions in their support modules. `npm test` discovers all core `*.test.mjs` suites; Playwright discovers browser
`*.spec.ts` suites. To run one browser suite, use `npm run test:browser -- tests/browser/playback.spec.ts`.

[GitHub Actions](.github/workflows/ci.yml) runs formatting checks, core/Python tests, the production build, and browser
tests on every push and pull request. Browser reports and failure traces are retained for 14 days;
the two simulation-artifact tests skip until their log fixtures are supplied.

## Development

React/TypeScript, Three.js, and uPlot power the frontend. Start with [Workbench](src/Workbench.tsx) for UI,
[data](src/data/) for log handling, [math](src/math/) for diagnostics, and [workers](src/workers/) for data preparation.
Keep full-resolution data for analysis and exports; decimate only for display.

The Python exporter lives in [tools/rdd2_exporter](tools/rdd2_exporter/); the existing script remains its CLI entry point.
See [the Arrow format contract](docs/arrow-format.md) for schema, metadata, and interoperability details.

```sh
npm run format
npm run format:check
uv run --locked black tools tests
```

Prettier and Black target 120-character lines; add `--check` to the Black command to validate.
Python dependencies live in `pyproject.toml` and `uv.lock`; `.python-version` selects Python 3.11 by default.
Use `uv add` / `uv add --dev` to change dependencies and include the updated `uv.lock` in the same commit.
Use `uv lock --upgrade-package <package>` for a compatible dependency update, or edit an exact pin with `uv add`.
To install the locked development environment explicitly or regenerate the Python-to-JavaScript test fixture:

```sh
uv sync --locked
uv run --locked tests/fixtures/generate_arrow.py
```

Profile imports with `npm run benchmark -- /path/to/trace.arrow` (CSV also supported).

Licensed under [MIT](LICENSE).
