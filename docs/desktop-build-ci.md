## How the Build Runs

The desktop release workflow builds the Tauri app across the supported desktop matrix whenever `release-desktop.yml` is triggered by a `desktop-v*` tag or a manual dispatch from the Actions tab.

The build matrix now compiles for **6 desktop targets in parallel**:

| Platform        | Binary                      |
| --------------- | --------------------------- |
| macOS (arm64)   | `.dmg`                      |
| macOS (x64)     | `.dmg`                      |
| Linux (x64)     | `.AppImage`, `.deb`, `.rpm` |
| Linux (arm64)   | `.AppImage`, `.deb`, `.rpm` |
| Windows (x64)   | `.msi`, `-setup.exe`        |
| Windows (arm64) | `-setup.exe`                |

The workflow uses native GitHub-hosted runners for each architecture, including `ubuntu-22.04-arm` for Linux arm64 and `windows-11-arm` for Windows arm64. The Windows arm64 lane currently publishes the NSIS setup executable rather than MSI so the ARM release path stays aligned with the documented Tauri installer guidance.

## Build Pipeline

1. **Build** — Compiles and bundles the Tauri desktop app for each target in the matrix.
2. **Sign** — Produces updater signatures when the release signing key is configured, and performs platform signing where the required secrets are present.
3. **Upload** — Pushes the generated artifacts into the draft GitHub Release associated with the desktop tag.

Dependency vulnerabilities are surfaced by GitHub's Dependabot alerts on the repository rather than as an in-workflow gate.

## Download and Test

After the workflow completes:

1. Open the draft release in GitHub Releases.
2. Download the artifact for your target architecture.
3. Install the `.dmg`, `.exe`, `.msi`, `.deb`, `.rpm`, or run the matching `.AppImage`.

## Manual Runs

To trigger the workflow manually, use the **Actions** tab, choose **Release Desktop (Tauri)**, and provide a tag such as `desktop-v0.7.0`.
