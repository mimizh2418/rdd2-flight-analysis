# RDD2 Flight Analysis

A browser application for replaying and comparing RDD2 drone simulations from
[modelica_models](https://github.com/mimizh2418/modelica_models) and
[Rumoca](https://github.com/CogniPilot/rumoca). Logs are processed locally in your browser.

Built with AI slop because I don't have time to do it properly.

## Features

- **3D replay:** compare trajectories and poses, or inspect a centered vehicle's attitude, velocity, and motor effort.
- **Telemetry graphs:** configurable signals and styles, dual Y axes, zoom, and automatic scaling.
- **Diagnostics:** tracking errors, path deviation, and estimator uncertainty when the necessary channels are present.
- **Comparison and export:** synchronized logs and tabs, event alignment, saved workspaces, and Arrow/CSV/statistics export.
- **Live simulation (planned):** run RDD2 simulations in-browser with Rumoca WebAssembly, live 3D/telemetry updates,
  and recording for later analysis.

## Getting started

Install [Nix](https://nixos.org/download/) with `nix-command` and `flakes` enabled, then run from the repository root:

```sh
nix develop
rdd2-install
rdd2-dev
```

Nix supplies pinned Node.js/npm, Python, uv, development tools, and the `mimizh2418/modelica_models` fork at
`345af4a389c150bde720f423ee2531494aa1a675`, including trajectory feedforward. uv manages Python dependencies in `.venv-nix`;
a separate model checkout is unnecessary. The 3D views require WebGL.

All `rdd2-*` commands below assume this shell and the repository root.
See [Nix tooling](docs/nix.md) for the full shortcut list, platform details, and [setup without Nix](docs/nix.md#without-nix).

Import a `.arrow` log with embedded simulation metadata and mission geometry. CSV remains supported with a `time`
or `time_s` column in seconds and an optional matching `manifest.json` for hash verification and provenance.
RDD2 channels are recognized automatically; other numeric columns remain available as raw signals.

Shift-drag pans graphs. Paused hover previews data without seeking. Saved workspaces contain settings;
reimport the original logs to restore their data.

Coordinates use East-North-Up (world) and Forward-Left-Up (body). Thrust is a collective command, not measured rotor thrust.

See the [documentation](docs/README.md) for view controls, playback/workspaces, diagnostics, and the
[Arrow log format](docs/arrow-format.md).

## Generating logs (optional)

Run a project scenario against the pinned library. Rumoca 0.10.2 includes its compiler and solver; no separate Rumoca CLI is needed:

```sh
rdd2-simulate scenarios/rumoca-scenario.qualification-mocap.toml
```

The log defaults to `exports/qualification-mocap/trace.arrow`; use `--out PATH` to change the directory.
Import `trace.arrow`; its metadata is embedded, so no sidecar is needed. Add `--format csv` to produce
`trace.csv` and `manifest.json` instead. Use `rdd2-simulate --help` for simulation settings and mission geometry.

See [scenarios](scenarios/README.md) for the mocap qualification mission, Dubins circles, and Bezier Lissajous figure-eight.

To convert an existing CSV without running a simulation, use the secondary command:

```sh
rdd2-convert-csv existing.csv --out exports/flight
```

Simulation metadata records compiler identity, source provenance, and timings.
See [simulation tooling](docs/simulation-tool.md) for details.

For batch simulations from the app, run `rdd2-service` and connect **Simulation** to `http://127.0.0.1:8765`.

## Build and test

```sh
rdd2-build          # Type-check and build into dist/
rdd2-serve          # Build, then serve the production bundle locally
rdd2-test           # Core, Python, build, and browser tests
```

`rdd2-preview` serves an existing build. Linux browser tests use pinned Chromium;
see [browser setup](docs/nix.md#browsers-and-maintenance) for macOS.
Browser tests start their own server; set `RDD2_GPS_TRACE` to a qualification CSV
or `RDD2_RUMOCA_BUNDLE` to a bundle directory to include optional artifact tests.

Tests are grouped by behavior in [tests/core](tests/core/) and [tests/browser](tests/browser/), with shared fixtures
and actions in their support modules. Core tests discover all `*.test.mjs` suites; Playwright discovers browser
`*.spec.ts` suites. Use `rdd2-test-core` / `rdd2-test-python` for individual unit-test suites,
or `rdd2-test-browser tests/browser/playback.spec.ts` for one browser suite.
Tests cover the exporter/viewer workflow using runtime stubs and saved logs; scenario checks compile without running
the solver. Full mission simulation and flight qualification belong to `modelica_models`, not this test suite.

[GitHub Actions](.github/workflows/ci.yml) uses the same locked Nix environment for formatting checks, core/Python tests,
production builds, and browser tests on every push and pull request. Successful pushes to `main` deploy to GitHub Pages.
Browser reports and failure traces are retained for 14 days;
the two simulation-artifact tests skip until their log fixtures are supplied.

## Development

React/TypeScript, Three.js, and uPlot power the frontend. Start with [Workbench](src/Workbench.tsx) for UI,
[data](src/data/) for log handling, [math](src/math/) for diagnostics, and [workers](src/workers/) for data preparation.
Keep full-resolution data for analysis and exports; decimate only for display.

The Python simulation tool starts at [tools/rdd2_simulate.py](tools/rdd2_simulate.py), with simulation, serialization,
and provenance modules in [tools/rdd2_simulation](tools/rdd2_simulation/).

```sh
rdd2-format         # Prettier, Black, and Nix formatting
rdd2-check          # Check all formatting
```

Prettier and Black target 120-character lines.
Python dependencies live in `pyproject.toml` and `uv.lock`; `.python-version` selects Python 3.11 by default.
Use `uv add` / `uv add --dev` to change dependencies and include the updated `uv.lock` in the same commit.
Use `uv lock --upgrade-package <package>` for a compatible dependency update, or edit an exact pin with `uv add`.
The shortcuts prepare the Python environment automatically. To regenerate the Python-to-JavaScript test fixture:

```sh
uv run --locked tests/fixtures/generate_arrow.py
```

Profile imports with `rdd2-benchmark /path/to/trace.arrow` (CSV also supported).

Licensed under [MIT](LICENSE).
