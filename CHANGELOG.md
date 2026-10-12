# Changelog

User-facing changes in each release. `scripts/release-notes.mjs` writes each
section from commit messages when the version is bumped, and the app store
release notes are taken from here. To change what a commit says, add a
`Release-note: <text>` line to its message (or `Release-note: none` to leave
it out).

## 0.14.30 (2026-10-11)

### Fixes

- Thread on server thread_id, keep cached threading headers, share Message-ID with Sent copy
