# Forward Email Homebrew Tap

This directory is the seed content for the first-party
[`forwardemail/homebrew-forwardemail`](https://github.com/forwardemail/homebrew-forwardemail)
tap. Copy `Casks/forward-email.rb` and this README into that repository before
enabling automated updates from the main application repository.

## User installation

```bash
brew tap forwardemail/forwardemail
brew install --cask forward-email
```

Upgrade with:

```bash
brew update
brew upgrade --cask forward-email
```

The cask selects the Apple Silicon or Intel GitHub Release DMG for the current
Mac automatically. Its SHA-256 values are release-specific and must be updated
with the matching asset URLs.

## Maintainer setup

The application repository contains an opt-in workflow,
[`publish-homebrew-tap.yml`](../.github/workflows/publish-homebrew-tap.yml). It
downloads the two macOS DMGs from a published GitHub Release, calculates their
SHA-256 values, and opens or updates a version-specific pull request here.

| Main repository setting   | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `HOMEBREW_TAP_TOKEN`      | A `release` environment secret limited to this repository's Contents and Pull requests read/write permissions |
| `HOMEBREW_TAP_REPOSITORY` | Optional; defaults to `forwardemail/homebrew-forwardemail`                                                    |
| `PUBLISH_HOMEBREW_TAP`    | Set to `true` only after the token and this tap exist                                                         |

Create an `automated` label in this repository or remove the optional workflow
label before its first run. The generated pull request should contain only the
version, two architecture-specific URLs, and their calculated SHA-256 values.
Review and merge it under the normal release approval policy.

See the main repository's
[distribution publishing guide](../docs/distribution-publishing.md#homebrew-tap)
for the complete credential and release procedure, and the
[Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook) for cask-policy
details.
