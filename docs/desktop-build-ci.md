# Desktop Build CI — Contributor Guide

## How the Build Runs

Every pull request to `main` that touches these paths triggers the desktop build:

- `src-tauri/**` — Rust code
- `src/**` — Frontend code
- `package.json` or `pnpm-lock.yaml` — Dependencies

The build matrix compiles for **4 platforms in parallel**:

| Platform      | Binary              |
| ------------- | ------------------- |
| macOS (arm64) | `.dmg`              |
| macOS (x64)   | `.dmg`              |
| Linux (x64)   | `.AppImage`, `.deb` |
| Windows (x64) | `.msi`, `.exe`      |

## Build Pipeline

1. **Build** — Compiles for all platforms (unsigned CI binaries)
2. **Upload** — Artifacts available for 7 days in the PR's artifacts section

Dependency vulnerabilities are surfaced by GitHub's Dependabot alerts on the repository rather than as an in-workflow gate.

## Download and Test

After the build completes:

1. Go to the PR → **Details** tab → **Artifacts** section
2. Download the binary for your platform (e.g. `desktop-macOS-arm64`)
3. Extract and run the `.dmg` or equivalent

## Skipping the Build

If your PR only modifies files outside the paths above (e.g. docs, CI config, web-only code), the build won't trigger.

To force a build, use the **Actions** tab → **Run workflow** button to manually trigger `Build Desktop (Tauri)`.
