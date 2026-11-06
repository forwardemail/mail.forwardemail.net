# Changelog

User-facing changes in each release. `scripts/release-notes.mjs` writes each
section from commit messages when the version is bumped, and the app store
release notes are taken from here. To change what a commit says, add a
`Release-note: <text>` line to its message (or `Release-note: none` to leave
it out).

## 1.0.4 (2026-11-06)

### Fixes

- Fewer requests while mail arrives in bursts

## 1.0.3 (2026-11-05)

### Fixes

- Switching folders and returning to the app is faster and uses less data, while changes made by others in a shared inbox still appear right away
- Messages read or changed on another device while this one was closed now show their current state, including older messages
- Opening a folder the socket kept current sends no request
- Opening a folder you looked at recently no longer downloads its message list again

## 1.0.2 (2026-11-05)

### Fixes

- iOS scene, sync totals and priority, account auth, icon labels

## 1.0.1 (2026-11-05)

### Fixes

- The desktop app no longer switches to another account when you return to it after it has been idle or asleep
- Offline message caching picks up again on its own after the server has been slow, without restarting the app
- Keep lightweight lists on for pages without senders

## 1.0.0 (2026-11-02)

### Fixes

- Filters that forward a copy of a message can be saved again, and forwarded messages now stay in your inbox

## 0.16.1 (2026-10-31)

### Fixes

- Label and move menus no longer hide behind a message's attachments, and reopening a draft no longer adds your signature above its text

## 0.16.0 (2026-10-29)

### New

- Desktop now protects saved passwords and PGP keys with your system
- Create PGP keys, see verified signatures, and sign without encrypting
- Remote images are blocked by default; allow them per message or per sender
- Signed (not encrypted) PGP mail now shows whether its signature checks
- Unsubscribe from lists, block senders, and see warnings on suspicious senders

### Fixes

- On desktop, email content is now fully isolated from the app
- Keep email frames working on older WebKit _(Desktop)_
- Recover from stale chunks on WebKit

## 0.15.12 (2026-10-26)

### Fixes

- Relaunch the app when its WebView stops answering
- Credit the original sender in desktop reply quotes

## 0.15.11 (2026-10-26)

### Fixes

- Harden compose, sanitizer, calendar and desktop links

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
