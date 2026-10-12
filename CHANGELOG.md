# Changelog

User-facing changes in each release. `scripts/release-notes.mjs` writes each
section from commit messages when the version is bumped, and the app store
release notes are taken from here. To change what a commit says, add a
`Release-note: <text>` line to its message (or `Release-note: none` to leave
it out).

## 0.14.31 (2026-10-12)

### Fixes

- The app no longer shows a blank screen while it starts
- No more white flash when opening the app in dark mode _(iOS)_

## 0.14.30 (2026-10-11)

### Fixes

- Conversations stay together and match Thunderbird and other mail apps. Most noticeable on mobile, where replies could split into separate threads
- Replies to an email you sent now join the same conversation as your Sent copy
- Replying from an account that isn't on screen still marks the original email as replied
- A send retried after a dropped connection no longer shows as failed when the email already went out
