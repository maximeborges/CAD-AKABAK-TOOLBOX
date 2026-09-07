# CAD-Akabak Toolbox

A desktop toolbox for loudspeaker and horn design: horn/waveguide geometry
generation, meshing, a built-in BEM acoustic solver, a driver database, and
export of lumped-element models to AKABAK (`.akp`).

Built with [Electron](https://www.electronjs.org/). Windows, macOS and Linux.

---

## Contents

- [Modules](#modules)
- [Install](#install)
- [Prerequisites for advanced features](#prerequisites-for-advanced-features)
- [Configuration](#configuration)
- [Run from source](#run-from-source)
- [Project layout](#project-layout)
- [Architecture](#architecture)
- [Running the validation harnesses](#running-the-validation-harnesses)
- [Build locally](#build-locally)
- [Releasing](#releasing)
- [Legacy code and rough edges](#legacy-code-and-rough-edges)

---

## Modules

| Module | What it does |
| --- | --- |
| **Geometry** | Geometry construction and editing |
| **Calculator** | Acoustic/electrical power calculations |
| **Mesh & Frequency** | Surface meshing (via gmsh) and frequency-domain setup |
| **Driver DB** | Loudspeaker driver database, with a scraper and optional OCR import |
| **Horn Expansion** | Horn profile expansion laws |
| **Horn Studio** | Interactive 3D horn design |
| **Waveguide Studio** | Interactive 3D waveguide design, including DOSC profiles |
| **BEM Solver** | Boundary-element acoustic simulation, directivity/polar maps, and a vent-flow CFD pipeline |
| **Akabak LEM** | Generates binary AKABAK lumped-element model files (`.akp`) |
| **Notes** | Project notes |
| **Configuration** | Paths, hotkeys, theming, module order |

Two features ship disabled by default and are toggled in `src/features.js`:
`isDriverOcrEnabled` (OCR driver import) and `isEnclosureCalculatorEnabled`
(enclosure calculator in the Calculator module).

## Install

Download the installer for your platform from the
[latest release](https://github.com/maximeborges/CAD-AKABAK-TOOLBOX/releases/latest):

| Platform | File |
| --- | --- |
| Windows | `CAD-Akabak-Toolbox-<version>-win-x64.exe` |
| macOS (Apple Silicon) | `CAD-Akabak-Toolbox-<version>-mac-arm64.dmg` |
| macOS (Intel) | `CAD-Akabak-Toolbox-<version>-mac-x64.dmg` |
| Linux | `CAD-Akabak-Toolbox-<version>-linux-x86_64.AppImage` |

On Linux, make the AppImage executable before running it:

```sh
chmod +x CAD-Akabak-Toolbox-*.AppImage
./CAD-Akabak-Toolbox-*.AppImage
```

### First launch

The builds are **not code-signed**, so the OS will warn about an unknown
developer:

- **Windows** — SmartScreen: choose *More info* → *Run anyway*.
- **macOS** — right-click the app and choose *Open*, or clear the quarantine
  flag: `xattr -dr com.apple.quarantine "/Applications/CAD-Akabak Toolbox.app"`

## Prerequisites for advanced features

The core app runs standalone. These modules shell out to external tools that
you must install separately:

| Feature | Requires | Platform |
| --- | --- | --- |
| Meshing (**Mesh & Frequency**) | [gmsh](https://gmsh.info/) — set its path in Configuration | All |
| Vent-flow CFD (**BEM Solver**) | OpenFOAM — natively on Linux, via WSL on Windows (see below) | Windows, Linux |
| **Akabak LEM** generation | Python 3 on `PATH` | All |
| OCR driver import | Internet access (Tesseract.js is loaded from a CDN) | All |

The BEM solver itself is implemented in JavaScript and needs no external
solver — the modules above are the only ones with outside dependencies.

### OpenFOAM for the vent CFD pipeline

- **Windows** — the BEM Solver panel installs OpenFOAM into a WSL
  Ubuntu-24.04 distribution for you (~1 GB, no administrator rights). Enabling
  WSL itself does need an elevated `wsl --install`, which the panel tells you
  about.
- **Linux** — install OpenFOAM from your distribution's packages (the
  `openfoam` package), then press *Re-check*. Set `FOAM_BASHRC` to the
  installation's `etc/bashrc` if it lives somewhere unusual. Common prefixes
  are detected automatically, as is an already-sourced environment.
- **macOS** — not available. There is no practical native OpenFOAM build; the
  panel says so rather than offering a setup that cannot work.

## Configuration

Settings live in the **Configuration** module and persist via `electron-store`.
The paths worth setting first:

- `gmsh` — path to the gmsh executable, required for meshing
- `downloads` — where exports are written
- `dataRoot` — root folder for project data
- `driversFolder` — driver database location

Hotkeys, theme, reduced motion, zoom, and module ordering are configurable in
the same place.

## Run from source

Requires **Node.js 22 or later**. This is a hard requirement, not a
recommendation: the app relies on Node's `require(esm)` support, and fails with
a `SyntaxError` on Node 18.

```sh
git clone https://github.com/maximeborges/CAD-AKABAK-TOOLBOX.git
cd CAD-AKABAK-TOOLBOX
npm install
npm start
```

## Project layout

```
src/
  main.js          Main process entry: app lifecycle, windows, IPC registration
  preload.js       contextBridge API exposed to the renderer
  features.js      Feature flags
  index.html       Renderer entry
  core/            Window manager, settings (electron-store)
  ipc/             Main-process IPC handlers (filesystem, mesh, foam, akabak, settings)
  js/
    bem/           BEM acoustic solver (~7.7k LOC, worker_threads)
    panels/        One folder or file per module
    popup/         Detached tool windows
    lib/           Vendored three.module.js, OrbitControls, chart.umd.js
    utils/
  css/             input.css (Tailwind source) -> style.css (committed output)
  assets/          Icons, splash screen
scripts/
  foam/            Bash scripts for the OpenFOAM pipeline (run in WSL on Windows,
                   directly on Linux)
  *.mjs            Node validation harnesses for the solver and geometry code
build/             Icons consumed by electron-builder
```

## Architecture

- **Main process** — CommonJS. `src/main.js` is a thin orchestrator: it creates
  windows through `src/core/windowManager.js` and registers the IPC handler
  modules in `src/ipc/`. All filesystem access and external process spawning
  happens here.
- **Renderer** — vanilla JavaScript with native ES modules, loaded directly by
  `src/index.html`. **There is no bundler and no UI framework** — no webpack,
  vite, React or Vue. `jsconfig.json` exists only for editor support.
- **3D** — three.js, vendored into `src/js/lib/` rather than imported from
  `node_modules`.
- **Numerics** — the BEM solver in `src/js/bem/` is written from scratch in JS
  and parallelized with `worker_threads`. The `scripts/*.mjs` harnesses exercise
  it headlessly, outside Electron.
- **CSS** — Tailwind is the source format (`src/css/input.css`), but the
  compiled `src/css/style.css` is committed and is what `index.html` loads.

## Running the validation harnesses

`scripts/*.mjs` are headless Node harnesses that exercise the BEM solver,
geometry and meshing code outside Electron. Run them from the repository root:

```sh
node scripts/bem_validate.mjs
node scripts/foam_env_validate.mjs
```

Two environment variables keep them machine-independent:

| Variable | Purpose |
| --- | --- |
| `GMSH` | Path to the gmsh binary for harnesses that mesh. Defaults to `gmsh` on `PATH`. Most also accept `--gmsh <path>` or a positional argument. |
| `TBBS_DATA_DIR` | Directory holding the reference `.TBBS` studies (`DEV-BEM/`, `AKABAK CURVES/`). These datasets are no longer used and are **not** in the repository; harnesses needing them fail with an explicit message naming the file. |


```sh
GMSH=/usr/bin/gmsh node scripts/dosc_geo_harness.mjs
TBBS_DATA_DIR=~/akabak-data node scripts/bem_flux_report.mjs
```

Harnesses that require WSL (the OpenFOAM bridge) report `SKIP` and exit `0` on
Linux and macOS rather than failing.

Note that several harnesses **write into `scripts/out/`, which is tracked by
git** — running them dirties the working tree. Check `git status` afterwards.

## Build locally

```sh
npm ci
npm run build:linux   # or build:win / build:mac
```

Installers are written to `dist/`. **Each platform must be built on its own OS**:
the `.dmg` requires macOS and the NSIS `.exe` requires Windows. Use
`npx electron-builder --win --dir` to validate packaging cross-platform without
producing an installer.

## Releasing

CI (`.github/workflows/ci.yml`) runs on every push and pull request to `main`,
building the app on Linux, Windows and macOS and uploading the installers as
short-lived workflow artifacts.

To publish a release, bump the version and push a matching tag:

```sh
npm version patch        # or minor / major — updates package.json
git push origin main --follow-tags
```

The `Release` workflow (`.github/workflows/release.yml`) then builds all three
platforms and attaches the installers to a GitHub release. The tag **must**
match `package.json` (tag `v3.0.2` ↔ version `3.0.2`) or the workflow fails
before building anything.

`Release` can also be triggered manually from the Actions tab against an
existing tag, which is the way to retry a failed publish.

## Legacy code and rough edges

A working install is not the issue here — the app has been installed and
exercised on a clean machine. What follows is context for anyone reading the
source, not a list of things you must fix to run it.

The repository still carries a fair amount of superseded work: experiments that
did not pan out, functions that were replaced rather than removed, and
harnesses pointing at datasets that are no longer used. A cleanup pass is
planned. Until then:

- **Most `scripts/*.mjs` harnesses are historical.** They were written to debug
  specific problems and are not a test suite. Several look for reference
  `.TBBS` studies under `DEV-BEM/` or `AKABAK CURVES/` that are no longer used
  and are not in the repository; they now say so explicitly instead of failing
  with a bare `ENOENT`. See [Running the validation harnesses](#running-the-validation-harnesses)
  for the `TBBS_DATA_DIR` override if you do have them.
- **`src/js/bem/bemMultiDomainBackend.js` is not reachable from the app** — it
  is imported only by `scripts/test_bem_multidomain.js`, and its worker path
  targets the browser (`fetch`, `Blob`, `Worker`).
- **`docs/version-manager.js` is absent**, so the `version:*` npm scripts do
  not work. Use `npm version patch` instead, which is what the release flow
  needs.
- **The CSS build step is missing.** `src/css/input.css` is Tailwind source and
  `src/css/style.css` is its committed output, but there is no
  `tailwind.config.js` and no npm script, so edits to `input.css` cannot
  currently be compiled. Edit `style.css` directly, or restore the build.
- **Several declared dependencies are unused**: `axios`, `builder` (an
  unrelated package, likely installed by mistake), and
  `chart.js` / `three` / `tesseract.js`, which are vendored under
  `src/js/lib/` or loaded from a CDN rather than taken from `node_modules`.
  They are still packaged into every installer.
- **Two harness assertions fail** (`dosc_geo_harness.mjs`,
  `dosc_brep_harness.mjs`), both about which surfaces belong to which
  `Physical Surface` group. They are stale expectations or exporter bugs —
  deciding which needs someone who knows the intended geometry.
- **No automated tests.** CI verifies that the app packages successfully on all
  three platforms; it does not check behaviour.
