# Distribution Research Notes

> Internal implementation notes. Do not present this file as a user-facing installation guide.

## Flathub

Official requirements state that Flathub builds must have no network access, source-available apps must build from source, and every dependency must be represented by publicly accessible manifest sources or local sources in the dedicated Flathub submission repository. The application manifest must be top-level, match the application ID, and the runtime must be current. Source: [Flathub Requirements](https://docs.flathub.org/docs/for-app-authors/requirements).

The maintained Flathub process is pull-request based: a release update should enter the Flathub app repository as a PR, receive a test build, be installed and tested, then be merged. An official build after merge is published by Flathub. Direct pushes to protected `master` are not the normal workflow. Source: [Flathub Maintenance](https://docs.flathub.org/docs/for-app-authors/maintenance).

Flathub runs the global External Data Checker every two hours for default branches. `x-checker-data` can generate an update PR. Auto-merge requires a request/approval, and Flathub recommends against it because a successful build does not prove application functionality. Custom external workflows should be reasonably infrequent and custom actions in a Flathub repository that write branches/PRs are restricted. Sources: [Maintenance](https://docs.flathub.org/docs/for-app-authors/maintenance) and [GitHub Actions](https://docs.flathub.org/docs/for-app-authors/github-actions).

Tauri's official Flatpak guide requires generated Node and Cargo dependency sources, supports `org.freedesktop.Sdk.Extension.node22` and `rust-stable`, and builds the app from source. Source: [Tauri Flathub guide](https://v2.tauri.app/distribute/flatpak/). `flatpak-node-generator` explicitly supports pnpm and creates the pnpm store population script/configuration necessary for `pnpm install --offline --frozen-lockfile`. Source: [flatpak-builder-tools node README](https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/node/README.md).

## Snap Store

`snapcore/action-build` publishes a `snap` output path and is intended to chain with `snapcore/action-publish`. Store credentials must be produced by `snapcraft export-login`; they can be limited to one snap, selected ACLs, channels, and an expiration. Sources: [action-build](https://github.com/snapcore/action-build), [action-publish](https://github.com/snapcore/action-publish), and [Snapcraft export-login](https://ubuntu.com/docs/snapcraft/9/reference/commands/export-login/).

The core24 GNOME extension supplies desktop integration, platform content plugs, WebKit layouts, and default desktop plugs. Additional plugs must be justified by application capabilities. Source: [GNOME extension](https://snapcraft.io/docs/gnome-3-38-extension/).

## F-Droid and Obtainium

F-Droid supports self-hosted simple binary repositories: APKs are put in a `repo` directory, metadata is maintained separately, and `fdroid update` creates the signed indexes. A real-world deployment must keep the repository signing key and configuration off the public web host. Source: [Setup an F-Droid App Repo](https://f-droid.org/en/docs/Setup_an_F-Droid_App_Repo/).

Obtainium tracks versioned GitHub release assets and can install/update apps directly from GitHub. It supports GitHub sources, F-Droid repositories, direct APK URLs, and other sources. Source: [Obtainium](https://github.com/ImranR98/Obtainium).

Vela was examined only as an implementation reference. It uses a self-hosted F-Droid binary repository on GitHub Pages, documents the fingerprint URL, and tells users that its F-Droid repo differs from the official F-Droid catalog. Sources: [Vela README](https://github.com/PimpinPumpkin/Vela) and [Vela F-Droid guide](https://raw.githubusercontent.com/PimpinPumpkin/Vela/main/FDROID.md).

## Homebrew

Homebrew upstream casks are submitted to `Homebrew/homebrew-cask` using a normal reviewable pull request. `brew bump-cask-pr` can create update PRs; upstream merges remain controlled by Homebrew maintainers. For zero-latency automated distribution, an official first-party tap can be maintained separately and releases can create PRs in that tap. Source: [Homebrew PR guide](https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request).

## Obsidian clarification

Obsidian's community directory distributes plugins and themes, not arbitrary desktop/mobile apps. The user clarified that the intended platform is Obtainium.

## Known corrections required relative to earlier patch drafts

1. The Flatpak manifest's previous git commit did not match v0.12.43; its annotated tag resolves to commit `77f0e888b1eed4314a775586ab7047be4a8ebc3b` in the prior audit checkout.
2. The previous Flatpak manifest was noncompliant because it ran network-dependent `pnpm install` without generated offline sources.
3. The prior Flathub sync workflow attempted a direct `master` push, conflicting with Flathub protected-branch, test-build, and PR workflows.
4. The Homebrew, F-Droid and Obtainium implementations must be split into appropriate upstream/community process versus first-party automation with a user-controlled repository/tap.

## Sources

- https://docs.flathub.org/docs/for-app-authors/requirements
- https://docs.flathub.org/docs/for-app-authors/submission
- https://docs.flathub.org/docs/for-app-authors/maintenance
- https://docs.flathub.org/docs/for-app-authors/github-actions
- https://v2.tauri.app/distribute/flatpak/
- https://github.com/flatpak/flatpak-builder-tools
- https://github.com/snapcore/action-build
- https://github.com/snapcore/action-publish
- https://ubuntu.com/docs/snapcraft/9/reference/commands/export-login/
- https://snapcraft.io/docs/gnome-3-38-extension/
- https://f-droid.org/en/docs/Setup_an_F-Droid_App_Repo/
- https://github.com/ImranR98/Obtainium
- https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request
- https://github.com/PimpinPumpkin/Vela
- https://raw.githubusercontent.com/PimpinPumpkin/Vela/main/FDROID.md

Last reviewed: 2026-08-12.

## Additional verified implementation constraints

A first-party Homebrew tap should be a repository named `homebrew-<name>` with casks under `Casks/`. Users can install a cask directly as `brew install --cask owner/homebrew-tap/cask`; Homebrew updates taps during `brew update`. The Cask Cookbook requires `version`, `sha256`, `url`, `name`, `desc`, `homepage`, and at least one artifact stanza such as `app`. A cask needs separate Intel and Apple Silicon SHA-256 values when releases use architecture-specific DMGs. Sources: [Homebrew Tap guide](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap) and [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook).

The official `homebrew/cask` tap cannot be automatically written by a project workflow; updates are submitted as reviewed PRs. The project can automate its own official tap, ideally by creating a reviewable PR with a repository-scoped fine-grained GitHub token and letting branch protection/auto-merge enforce review. Source: [Homebrew PR guide](https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request).

For the F-Droid binary-repository implementation, use a distinct repository-index signing key held only in Actions secrets and never commit the generated config/keystore. The workflow must publish Pages only after `fdroid update` has generated signed indexes and must delete the key/config before Pages artifact upload. A self-hosted binary repository differs from the official F-Droid catalog; the current BUSL-1.1 project license means a submission to the free-software-only official F-Droid catalog needs separate legal approval/change and is intentionally not automated.

The current upstream GitHub release assets use architecture-specific macOS DMG names `Forward.Email_<version>_aarch64.dmg` and `Forward.Email_<version>_x64.dmg`; a Homebrew cask therefore requires two platform-specific checksums. The current Android release uses `forwardemail-mail_<version>_android.apk`, while the Google-free variant must use a distinct, stable asset name such as `forwardemail-mail_<version>_fdroid.apk` so Obtainium can reliably select it.

The latest upstream source checked out for this audit is commit `62f8e49270d1c50867fe0d15255eda07b57711cf` on 2026-08-12.
