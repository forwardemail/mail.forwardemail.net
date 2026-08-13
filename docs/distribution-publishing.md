# Distribution Publishing Guide

This guide is the operational runbook for publishing Forward Email outside the
standard GitHub Release, Google Play, and TestFlight channels. It covers the
strict Snap, Flathub Flatpak, the official self-hosted F-Droid-compatible
repository, the first-party Homebrew tap, and Obtainium. It is designed so that
a normal `v*` release is hands-off **after** each store has completed its
one-time enrollment and the documented opt-in control has been enabled.

> The `release.yml` workflow deliberately treats Snap Store, the F-Droid
> repository, and the Homebrew tap as opt-in lanes. This preserves the existing
> release process until the relevant store account, signing material, and GitHub
> settings are ready. When a lane is enabled, a failure in that lane fails the
> release summary rather than silently reporting a stale distribution channel as
> healthy.

## Distribution model

| Channel                       | Package or source                                      | End-user installation                                                          | Release automation                                                                              | One-time owner action                                 |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Snap Store                    | Strict `core24` Snap                                   | `sudo snap install forwardemail-mail`                                          | Builds on the native Linux x64 release row and publishes to `stable` when enabled               | Reserve the name and add scoped Snapcraft credentials |
| Flathub                       | Source-built Flatpak                                   | `flatpak install flathub net.forwardemail.mail`                                | Flathub External Data Checker opens version-update PRs after the initial submission is accepted | Submit and maintain the Flathub repository            |
| F-Droid-compatible repository | Signed UnifiedPush-only APK and signed F-Droid indexes | Add the official repository URL and fingerprint to an F-Droid client           | Generates indexes and deploys them to GitHub Pages when enabled                                 | Create a dedicated index-signing key and enable Pages |
| Homebrew                      | Architecture-specific signed macOS DMGs                | `brew install --cask forwardemail/forwardemail/forward-email`                  | Opens or refreshes a pull request in the first-party tap when enabled                           | Create the tap and issue a narrowly scoped token      |
| Obtainium                     | The same Google-free GitHub Release APK                | Add `https://github.com/forwardemail/mail.forwardemail.net` as a GitHub source | No publishing integration is required                                                           | None beyond publishing the Google-free APK            |

The source repository holds the Flatpak manifest, Snapcraft manifest, F-Droid
metadata, and a cask template. The first-party Homebrew tap is intentionally a
separate repository, because Homebrew discovers casks from the tap rather than
from this application source tree.

## One-time GitHub configuration

Create the secrets in **Settings → Secrets and variables → Actions →
Environments → `release`**. Create the variables in either the `release`
environment or the repository, unless a row says otherwise. The canonical
inventory is [SECRETS.md](./SECRETS.md).

| Name                          | Kind             | Used by                    | Enablement condition                                       |
| ----------------------------- | ---------------- | -------------------------- | ---------------------------------------------------------- |
| `SNAPCRAFT_STORE_CREDENTIALS` | `release` secret | Snap Store publishing      | Required when `PUBLISH_SNAP_STORE=true`                    |
| `PUBLISH_SNAP_STORE`          | variable         | Snap Store publishing      | Set exactly to `true` after Snap Store setup               |
| `FDROID_KEYSTORE_BASE64`      | `release` secret | F-Droid index signing      | Required when `PUBLISH_FDROID_REPOSITORY=true`             |
| `FDROID_KEYSTORE_PASSWORD`    | `release` secret | F-Droid index signing      | Required when `PUBLISH_FDROID_REPOSITORY=true`             |
| `FDROID_REPOSITORY_URL`       | variable         | F-Droid index metadata     | Optional; defaults to the standard GitHub Pages URL        |
| `PUBLISH_FDROID_REPOSITORY`   | variable         | F-Droid publishing         | Set exactly to `true` after Pages setup                    |
| `HOMEBREW_TAP_TOKEN`          | `release` secret | Cask pull-request creation | Required when `PUBLISH_HOMEBREW_TAP=true`                  |
| `HOMEBREW_TAP_REPOSITORY`     | variable         | Cask target repository     | Optional; defaults to `forwardemail/homebrew-forwardemail` |
| `PUBLISH_HOMEBREW_TAP`        | variable         | Homebrew tap updater       | Set exactly to `true` after the tap and token exist        |

The release environment should have the customary protection and reviewer rules
for production signing material. Do not put the F-Droid private keystore,
Snapcraft macaroon, or cross-repository token in repository variables, commit
them, or print them in logs.

## Snap Store

The Snap is named `forwardemail-mail`, uses strict confinement, and exposes only
the `home`, `network`, and `network-status` interfaces. The manifest builds the
normal Debian bundle from the tagged source and stages its runtime dependencies;
therefore the Snap version follows `src-tauri/tauri.conf.json` exactly. Snapcraft
requires a registered name before automated pushes can succeed. [1] [2]

The application disables Tauri's GitHub updater when `SNAP` is present, for the
same reason it does under Flatpak: snapd is the authoritative updater and a
snap's own files are mounted read-only. The recipe also forces
`bundle.createUpdaterArtifacts` off, because the release job turns that flag on
in the checkout it hands to snapcraft and the signing key stays outside the
build instance.

### One-time setup

1. Sign in to [Snapcraft](https://snapcraft.io/), create the publisher account
   for Forward Email, and reserve `forwardemail-mail` before the first release.
   Use `snapcraft register forwardemail-mail` if the name is not already
   registered to the publisher.
2. Install the [Snapcraft CLI](https://snapcraft.io/docs/installing-snapcraft)
   on a trusted operator workstation, authenticate with `snapcraft login`, and
   export a restricted, expiring credential. Restricting it to the one snap and
   the stable channel minimizes the effect of accidental disclosure. [2]

   ```bash
   snapcraft export-login \
     --snaps=forwardemail-mail \
     --channels=stable \
     --acls=package_access,package_push,package_update,package_release \
     --expires=2027-08-12 \
     forwardemail-snapcraft-login.txt
   ```

3. Copy the entire contents of `forwardemail-snapcraft-login.txt` into the
   `release` environment secret `SNAPCRAFT_STORE_CREDENTIALS`. Delete the local
   exported file after it has been stored in the secret manager.
4. Set the Actions variable `PUBLISH_SNAP_STORE` to `true`. A tagged release now
   creates a `.snap` GitHub Release asset and sends the same file to the Snap
   Store `stable` channel.
5. Complete any Snap Store listing, publisher-verification, or manual-review
   requirements before expecting the package to be publicly searchable. Keep the
   automated workflow disabled until that first review is complete.

### Release and verification

Every Linux x64 desktop release builds the Snap and attaches it to the GitHub
Release. Store publication is the only gated step. After the first enabled
release, verify both the store record and a clean installation:

```bash
snap info forwardemail-mail
sudo snap install forwardemail-mail
forwardemail-mail
```

For a release candidate, change the workflow channel only through a reviewed
workflow change; do not use the production stable credential to publish an
unreviewed development build.

## Flathub Flatpak

The Flatpak application ID is `net.forwardemail.mail`. Its manifest builds from
pinned, offline Node and Cargo source manifests and packages against the GNOME
runtime. The application disables Tauri's GitHub updater only when
`FLATPAK_ID` is present, because Flatpak is the authoritative updater inside the
sandbox. The declared network, notification, Wayland, and X11 permissions are
kept in `finish-args` for review.

> **Redistribution prerequisite.** Flathub requires every hosted component to
> permit legal redistribution and requires the application license to be stated
> in the MetaInfo file. The project currently declares `BUSL-1.1`; an authorized
> Forward Email owner must confirm that the exact application build and every
> fetched dependency may be redistributed through Flathub, or supply the
> additional permission Flathub requests. Do not submit until this is resolved.
> [3]

### Initial submission

1. Install Flatpak and the Builder tooling on Linux. The [Flathub submission
   guide](https://docs.flathub.org/docs/for-app-authors/submission) explains how
   to create the application repository and submit it for review. [4]
2. In a fork or the new `flathub/net.forwardemail.mail` repository, place these
   source-repository files at its top level without renaming them:

   ```text
   net.forwardemail.mail.yml
   net.forwardemail.mail.metainfo.xml
   net.forwardemail.mail.desktop
   flatpak-node-sources.json
   flatpak-cargo-sources.json
   ```

3. Build the exact submitted manifest locally before opening the PR. Install the
   GNOME runtime and the `node22` and `rust-stable` SDK extensions requested by
   the manifest, then run:

   ```bash
   flatpak run org.flatpak.Builder \
     --user --install --force-clean --install-deps-from=flathub \
     build-dir net.forwardemail.mail.yml
   ```

4. Open the Flathub submission pull request, answer the review questions, and
   retain ownership of the resulting `flathub/net.forwardemail.mail` repository.
   The GitHub Actions bundle build is a pre-merge verification artifact; the
   Flathub build is the distribution build.

### Ongoing updates

The primary Git source in `net.forwardemail.mail.yml` includes Flathub
External Data Checker metadata. After Flathub accepts the application,
External Data Checker detects a matching `v<semver>` tag and creates a manifest
update pull request for review. That bot operates in the Flathub repository;
it needs **no GitHub token or secret in this source repository**. Review its
commit/tag change and the resulting build before merging. [5]

Users install the published application with:

```bash
flatpak install flathub net.forwardemail.mail
flatpak run net.forwardemail.mail
```

The initial submission and updates may be delayed by Flathub review and build
queue time. Do not claim availability in user-facing channels until the app page
is live at `https://flathub.org/apps/net.forwardemail.mail`.

## Self-hosted F-Droid-compatible repository

The Android workflow creates `forwardemail-mail_<version>_fdroid.apk`, a
Google-free UnifiedPush-only APK. It is signed with the normal Android release
key. The repository index is separately signed by a dedicated F-Droid repository
key. This is the official Forward Email binary repository; it is **not** a
submission to the public `f-droid.org` catalog.

### Create and protect the repository key

Create this key once on a secure workstation, retain an encrypted offline
backup, and use a unique password. Never reuse the Android APK signing key for
repository-index signing.

```bash
keytool -genkeypair \
  -keystore forwardemail-fdroid-repo.p12 \
  -storetype PKCS12 \
  -alias forwardemail-fdroid-repo \
  -keyalg RSA -keysize 4096 -validity 3650 \
  -dname "CN=Forward Email F-Droid Repository, O=Forward Email LLC, C=US"

# Record the SHA-256 certificate fingerprint for the public installation page.
keytool -list -v -keystore forwardemail-fdroid-repo.p12 \
  -alias forwardemail-fdroid-repo

# Linux: copy the resulting one-line value into GitHub Secrets.
base64 -w 0 forwardemail-fdroid-repo.p12
```

On macOS, use `base64 -i forwardemail-fdroid-repo.p12 | tr -d '\n'`. Store the
encoded value as `FDROID_KEYSTORE_BASE64` and the password as
`FDROID_KEYSTORE_PASSWORD`, both in the `release` environment. The key alias
must remain `forwardemail-fdroid-repo`, which is intentionally fixed in the
workflow and the command above.

### Enable hosting and release automation

1. In **Settings → Pages**, select **GitHub Actions** as the build and deployment
   source. Do not configure a `gh-pages` branch; the workflow uses GitHub's
   supported `configure-pages`, artifact-upload, and deployment actions. The
   first successful deployment creates the project Pages site. [6]
2. The standard project Pages URL requires **no `CNAME` file and no DNS setup**.
   Leave `FDROID_REPOSITORY_URL` unset to use this default:

   ```text
   https://forwardemail.github.io/mail.forwardemail.net/fdroid/repo
   ```

3. Use a custom domain only when you have deliberately configured its DNS and
   GitHub Pages custom-domain setting. Then set `FDROID_REPOSITORY_URL` to the
   final HTTPS `/fdroid/repo` path. Do **not** add a `CNAME` file merely to make
   the default `forwardemail.github.io` URL work.
4. Set `PUBLISH_FDROID_REPOSITORY=true`. A successful tagged release first
   uploads the Google-free APK to GitHub Releases, then the reusable publisher
   downloads exactly that asset, creates signed `index-v1.jar` and
   `index-v2.json` files with [fdroidserver](https://gitlab.com/fdroid/fdroidserver),
   and deploys only `/fdroid/repo` to Pages. The private key and build metadata
   are not included in the Pages artifact.
5. Publish the repository URL and the SHA-256 certificate fingerprint obtained
   above in the website and README only after the first deployment succeeds.
   Users should add the repository through their F-Droid client and compare the
   displayed fingerprint with the independently published value. [7]

A launch URL has the following form; replace the placeholder with the compact
SHA-256 fingerprint from `keytool` (typically uppercase hexadecimal without
colons):

```text
https://forwardemail.github.io/mail.forwardemail.net/fdroid/repo?fingerprint=<SHA256_FINGERPRINT>
```

After the deployment job reports success, open the published fingerprint URL
before sharing the repository. A 404 means that Pages has not yet been enabled
or no deployment has completed; it does **not** mean a CNAME is needed for the
default project-site URL. Then test with a clean F-Droid-compatible client: add
the repository, confirm its displayed signing fingerprint, refresh repositories,
install Forward Email, and confirm that the installed package identifier is
`net.forwardemail.mail` and that notifications can be configured through an
installed UnifiedPush distributor.

## Homebrew tap

Homebrew casks are published through a distinct Git repository. Create
`forwardemail/homebrew-forwardemail` (or set `HOMEBREW_TAP_REPOSITORY` to a
separate organization-approved target) and commit the template from
[`homebrew/Casks/forward-email.rb`](../homebrew/Casks/forward-email.rb) as
`Casks/forward-email.rb` in that repository. The template uses separate Apple
Silicon and Intel DMG URLs and SHA-256 values, and has a GitHub release
`livecheck` stanza. Homebrew documents the cask syntax and tap behavior in its
[Cask Cookbook](https://docs.brew.sh/Cask-Cookbook) and [Taps
Guide](https://docs.brew.sh/Taps). [8] [9]

### One-time setup

1. Create the public first-party tap repository. It must contain at least
   `Casks/forward-email.rb`, a license, and a short README that directs users to
   the Forward Email project. Merge the shipped cask template after checking it
   against the newest release DMGs.
2. Create a **fine-grained GitHub personal access token** or GitHub App
   installation token owned by a controlled release-maintainer account. Grant it
   only the target tap repository's **Contents: read and write** and **Pull
   requests: read and write** permissions. GitHub documents fine-grained token
   creation and repository restriction. [10]
3. Store it as the `release` environment secret `HOMEBREW_TAP_TOKEN`. Avoid
   reusing `GITHUB_TOKEN`: it cannot grant the source repository write access to
   a separate repository.
4. Set `PUBLISH_HOMEBREW_TAP=true`, and optionally set
   `HOMEBREW_TAP_REPOSITORY=forwardemail/homebrew-forwardemail` explicitly.
5. Add an `automated` label to the tap if it is desired for pull requests, or
   remove that optional workflow label before the first run. Configure required
   reviews or auto-merge in the tap according to the release-control policy.

When enabled, the workflow downloads both DMGs from the newly published GitHub
Release, calculates each SHA-256 itself, rewrites only the cask, validates Ruby
syntax, and creates or updates a versioned pull request. Review the PR and merge
it. Homebrew users then install and upgrade with:

```bash
brew tap forwardemail/forwardemail
brew install --cask forward-email
brew upgrade --cask forward-email
```

To request inclusion in `homebrew/homebrew-cask` after the first-party tap is
stable, follow Homebrew's contribution rules and submit the cask upstream. The
first-party tap remains the authoritative early-distribution path and is not
replaced by an upstream submission.

## Obtainium

[Obtainium](https://github.com/ImranR98/Obtainium) follows GitHub Releases and
installs updates directly from their assets. No key, account, secret, or
additional CI lane is required. The release workflow publishes one uniquely
named Google-free asset,
`forwardemail-mail_<version>_fdroid.apk`; that predictable name prevents the
normal dual-provider APK and Google Play AAB from being selected by mistake.

Users install Obtainium, choose **Add App**, enter the repository URL below,
select the GitHub source if prompted, and select the `_fdroid.apk` asset on the
first installation:

```text
https://github.com/forwardemail/mail.forwardemail.net
```

They should install a UnifiedPush distributor before enabling background
notifications. Subsequent tagged releases retain the same asset naming pattern,
so Obtainium can notify and update users without any manual publisher action.
For users who prefer repository metadata and fingerprint verification, recommend
the F-Droid-compatible repository instead.

## Per-release operator checklist

| Check              | Expected result                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Release     | Contains signed desktop assets, dual-provider Android APK/AAB, and `forwardemail-mail_<version>_fdroid.apk`                     |
| Snap GitHub asset  | Contains one `forwardemail-mail_<version>_amd64.snap`; `snap info` reports the released version if the lane is enabled          |
| Snap Store         | Stable channel contains the exact release version and launches under strict confinement                                         |
| F-Droid deployment | Pages serves `fdroid/repo/index-v1.jar`, `index-v2.json`, and the Google-free APK; client fingerprint matches the published key |
| Homebrew tap       | A pull request contains only the expected version, DMG URLs, and two calculated SHA-256 values                                  |
| Flathub            | Initial app page is live, or the Flathub External Data Checker pull request references the intended source tag and commit       |
| Obtainium          | GitHub source resolves to the Google-free APK and ignores the dual-provider APK/AAB                                             |

## References

[1]: https://snapcraft.io/docs/registering-your-app 'Snapcraft: Registering your app name'
[2]: https://github.com/snapcore/action-publish 'Snapcraft Publish GitHub Action'
[3]: https://docs.flathub.org/docs/for-app-authors/requirements 'Flathub requirements'
[4]: https://docs.flathub.org/docs/for-app-authors/submission 'Flathub submission guide'
[5]: https://docs.flathub.org/docs/for-app-authors/updates 'Flathub updates and External Data Checker'
[6]: https://docs.github.com/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site 'GitHub Pages publishing source'
[7]: https://f-droid.org/docs/Setup_an_F-Droid_App_Repo/ 'F-Droid: Set up an app repository'
[8]: https://docs.brew.sh/Cask-Cookbook 'Homebrew Cask Cookbook'
[9]: https://docs.brew.sh/Taps 'Homebrew Taps'
[10]: https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens 'GitHub fine-grained personal access tokens'
