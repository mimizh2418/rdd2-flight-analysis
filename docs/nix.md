# Nix tooling

Use [Nix](https://nixos.org/download/) with `nix-command` and `flakes` enabled. From the repository root:

```sh
nix develop
rdd2-install
rdd2-dev
```

The environment pins Node.js 22/npm, Python 3.11, uv, Git, a Nix formatter, certificates, and native runtime libraries
through `flake.lock`. Modelica sources are pinned independently to
`a1c3c30e1390f394d57e66546ffe2fa9a4eb184b`. They are fetched automatically into the read-only Nix store.
This repository's [scenarios](../scenarios/README.md) run directly from the working tree against those pinned sources.

## Shortcuts

These commands are available inside `nix develop`. Run them from the repository root.

| Command                               | Action                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| `rdd2-install`                        | `npm ci` and `uv sync --locked --extra simulation`          |
| `rdd2-dev`                            | Start the Vite development server                           |
| `rdd2-build`                          | Type-check and build into `dist/`                           |
| `rdd2-preview`                        | Serve an existing production build                          |
| `rdd2-serve`                          | Build, then serve the production bundle locally             |
| `rdd2-test`                           | Run core/Python tests, build, and run browser tests         |
| `rdd2-test-core` / `rdd2-test-python` | Run one unit-test suite                                     |
| `rdd2-test-browser`                   | Build, then run browser tests against the production bundle |
| `rdd2-check` / `rdd2-format`          | Check/apply Prettier, Black, and Nix formatting             |
| `rdd2-simulate` / `rdd2-service`      | Run a simulation or start its local service                 |
| `rdd2-convert-csv` / `rdd2-benchmark` | Convert CSV or benchmark imports                            |

Shortcuts that need frontend dependencies run `npm ci` when `node_modules` is absent.
Run `rdd2-install` again after changing dependency lock files. Pass arguments directly:

```sh
rdd2-test-browser tests/browser/playback.spec.ts
rdd2-simulate scenarios/rumoca-scenario.qualification-mocap.toml
rdd2-service --port 8766
```

Without entering a shell, Nix applications remain available as `nix run .#ACTION -- ARGS`,
for example `nix run .#simulate -- scenarios/rumoca-scenario.qualification-mocap.toml`.

## Python and model sources

uv continues to install packages from `uv.lock`; Nix does not replace Python dependency management.
`UV_PYTHON` selects the pinned interpreter and disables Python downloads. `.venv-nix` keeps this environment separate
from the ordinary `.venv`. Downloads are needed initially; entering the shell does not install project dependencies.

`RDD2_MODELICA_ROOT` points directly to the pinned upstream source tree. CLI scenario paths can be relative to that tree;
the service discovers upstream and local project scenarios. `RDD2_MODELICA_REVISION` supplies provenance when the source
has no `.git` folder.
An explicit `--modelica-root /path/to/checkout` still selects a developer checkout and its own identity.
Project scenarios run against that checkout directly; copying them into the checkout is unnecessary.

Scenario edits take effect on the next run without re-entering `nix develop`. Restart the service after adding new scenario
files. Provenance records the upstream `model_revision`; `source_sha256` covers both the library and local scenario sources.

Simulation logs default to `exports/<scenario-name>/`; `--out` overrides the directory.
The service uses its `--artifacts` directory.

## Browsers and maintenance

On Linux, the shell includes pinned Chromium through the browser shortcuts, which configure Playwright to use it.
For browser tests through ordinary npm commands, enter `nix develop .#browser` to export the browser path to Playwright.
On macOS, install the npm-pinned browser once with `npx playwright install chromium`.

The flake declares Linux and macOS on x86_64/aarch64. Windows users need a Linux environment such as WSL.
Browser packages are platform-specific; Python packages need compatible wheels or source builds.

Use `nix fmt` for Nix formatting. Update explicit input revisions in `flake.nix`, regenerate `flake.lock`, and validate
with `nix flake check`, `rdd2-check`, and `rdd2-test`. New flake files must be Git-tracked for commands using `.`
to include them. Both `package-lock.json` and `uv.lock` remain the dependency sources of truth.

## CI and deployment

[GitHub Actions](../.github/workflows/ci.yml) installs Nix and runs the same `rdd2-*` shortcuts through
`nix develop --no-update-lock-file --command`. All three jobs use `flake.lock`, `package-lock.json`, and `uv.lock`;
npm and uv downloads are cached. Linux browser tests use the Nix-pinned Chromium, with no separate browser download step.

Checks and browser tests run on every push and pull request. After both pass, pushes to `main` build with
`rdd2-build --base /rdd2-flight-analysis/` and deploy `dist/` to GitHub Pages.

## Without Nix

Install Node.js 22.12+ and npm for the viewer; install [uv](https://docs.astral.sh/uv/getting-started/installation/)
for Python tools. Run `npm ci` and `npm run dev`. Python commands create `.venv` automatically.

Shell shortcuts wrap the npm scripts: for example, `rdd2-build` corresponds to `npm run build`,
`rdd2-test-core` to `npm test`, and `rdd2-simulate ARGS` to `npm run simulate -- ARGS`.
Use `npm run` to list scripts; `rdd2-test` combines the unit tests, production build, and browser tests.
Install the browser with `npx playwright install chromium`, build, then run `RDD2_PREVIEW=1 npm run test:browser`.

For simulations, supply the model sources separately:

```sh
git clone https://github.com/CogniPilot/modelica_models ../modelica_models
git -C ../modelica_models checkout a1c3c30e1390f394d57e66546ffe2fa9a4eb184b
npm run simulate -- scenarios/rumoca-scenario.qualification-mocap.toml --modelica-root ../modelica_models
```
