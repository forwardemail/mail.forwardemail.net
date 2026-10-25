# Changelog

User-facing changes in each release. `scripts/release-notes.mjs` writes each
section from commit messages when the version is bumped, and the app store
release notes are taken from here. To change what a commit says, add a
`Release-note: <text>` line to its message (or `Release-note: none` to leave
it out).

## 0.15.10 (2026-10-25)

### Fixes

- Clearing saved keys keeps you signed in and removes what they decrypted

## 0.15.9 (2026-10-24)

### Fixes

- Stop the page dying at launch, and cut memory use while reading _(iOS)_

## 0.15.8 (2026-10-22)

### Fixes

- Fixed a signed-out account's search data being

## 0.15.7 (2026-10-22)

### Fixes

- Stop iOS page reloads, keep list position, land on inbox after account switch _(Android, iOS)_

## 0.15.6 (2026-10-22)

### New

- Send reports to support from the apps, and report memory, storage and reloads

## 0.15.5 (2026-10-20)

### Fixes

- Manage each event of a series, delete on mobile, native date and time fields

## 0.15.4 (2026-10-20)

### New

- Add mark as read setting and stop search marking results read

## 0.15.3 (2026-10-19)

### Fixes

- Archiving, deleting and moving mail no longer makes messages
- Long message lists stay responsive when starring,
- Reported spam now goes to your Spam folder when you
- Links in the compose window are easier to read in dark mode
- Fixed emails sometimes opening blank or cut off at the top

## 0.15.2 (2026-10-16)

### New

- New Power User density shows one message per

## 0.15.1 (2026-10-16)

### Fixes

- Fixed the macOS app quitting unexpectedly
- Fixed the app crashing repeatedly a few seconds after

## 0.15.0 (2026-10-16)

### New

- Right-click a contact (or Command-click on a Mac) to email,

### Fixes

- Folder unread counts now match across devices, and emails read on another device show as read
- Fixed unread counts that differed between devices,
- Fixed new encrypted messages showing a loading

## 0.14.32 (2026-10-14)

### Fixes

- If the app keeps going blank right after it opens, it now shows a troubleshooting page with diagnostics and a reset, instead of reloading forever _(Desktop)_
- New Help > Troubleshooting menu item _(Desktop)_
- Turning off App Lock no longer hangs on a large mailbox. Cached mail
- Tapping a new-mail notification now opens the message, including _(iOS)_
- New mail no longer shows two notifications when push is set up _(iOS)_
- New mail for another signed-in account now shows a notice that names the
- Accounts added with an API key no longer get stuck when opening a
- Tapping a notification after the app was closed no longer crashes it, and opens the right email _(iOS)_

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
