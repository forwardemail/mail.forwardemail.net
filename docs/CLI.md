# Forward Email in the Terminal

`forwardemail` runs the Forward Email webmail (mail, calendar, contacts and settings) inside a terminal. It is the same Svelte application as [mail.forwardemail.net](https://mail.forwardemail.net), with the same sign-in, encryption, workers and keyboard shortcuts. Instead of a browser engine, [TermDOM](https://github.com/bikeshaving/termdom) lays out and draws the page as text cells.

```sh
npm install -g forwardemail
forwardemail
```

## Contents

- [Install](#install)
  - [Standalone executable (no Node.js needed)](#standalone-executable-no-nodejs-needed)
  - [npm](#npm)
  - [Manual download](#manual-download)
- [Usage](#usage)
  - [Commands and options](#commands-and-options)
  - [Keys and mouse](#keys-and-mouse)
  - [Plain text](#plain-text)
  - [Notifications](#notifications)
  - [Environment variables](#environment-variables)
  - [Where data is stored](#where-data-is-stored)
  - [Custom styles](#custom-styles)
  - [Self-hosted servers](#self-hosted-servers)
- [Updates](#updates)
- [Verifying downloads](#verifying-downloads)
- [Uninstall](#uninstall)
- [Differences from the browser](#differences-from-the-browser)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Development](#development)
- [Releasing](#releasing)

## Install

### Standalone executable (no Node.js needed)

**macOS and Linux:**

```sh
curl -fsSL https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/install.sh | sh
```

The executable goes to `~/.local/bin/forwardemail`. The script tells you if that directory is not on your `PATH`.

**Windows (PowerShell):**

```powershell
irm https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/install.ps1 | iex
```

The executable goes to `%LOCALAPPDATA%\Programs\forwardemail\forwardemail.exe`, and that folder is added to your user `PATH`. Open a new terminal afterwards.

Both installers download the build for your system and CPU from the latest [GitHub release](https://github.com/forwardemail/mail.forwardemail.net/releases/latest). They check it against the release's `SHA256SUMS.txt` and refuse to install it if the checksum does not match. Both accept the same settings:

| Variable                   | Effect                                                         |
| :------------------------- | :------------------------------------------------------------- |
| `FORWARDEMAIL_VERSION`     | Install this version (for example `0.15.0`) instead of latest. |
| `FORWARDEMAIL_INSTALL_DIR` | Install into this directory instead of the default.            |

```sh
curl -fsSL https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/install.sh | FORWARDEMAIL_INSTALL_DIR=/usr/local/bin sh
```

Standalone builds are available for:

| System  | x64                        | arm64                        |
| :------ | :------------------------- | :--------------------------- |
| Linux   | `forwardemail-linux-x64`   | `forwardemail-linux-arm64`   |
| macOS   | `forwardemail-darwin-x64`  | `forwardemail-darwin-arm64`  |
| Windows | `forwardemail-win-x64.exe` | `forwardemail-win-arm64.exe` |

The Linux builds need glibc. On Alpine and other musl systems, install with npm instead. On an Apple Silicon Mac, the installer picks the arm64 build even when the shell runs under Rosetta.

### npm

Requires Node.js 22 or later.

```sh
npm install -g forwardemail
# or
pnpm add -g forwardemail
# or, without installing
npx forwardemail --demo
```

The npm package is a single JavaScript file of about 7 MB, plus the desktop notifier programs for macOS and Windows, with no dependencies. It runs anywhere Node.js does, including musl Linux, FreeBSD and other CPUs.

### Manual download

Download `forwardemail-<system>-<cpu>.gz` (or `.exe.gz`) from the [releases page](https://github.com/forwardemail/mail.forwardemail.net/releases/latest), then unpack it and make it executable:

```sh
gunzip forwardemail-linux-x64.gz
chmod +x forwardemail-linux-x64
mv forwardemail-linux-x64 ~/.local/bin/forwardemail
```

A file downloaded with a browser on macOS is quarantined by Gatekeeper; clear the flag with `xattr -d com.apple.quarantine ~/.local/bin/forwardemail`. Files fetched with `curl`, as the install script does, are not quarantined.

## Usage

```sh
forwardemail           # sign in and read your mail
forwardemail --demo    # look around with sample data, no account needed
```

### Commands and options

| Command                      | What it does                                                                           |
| :--------------------------- | :------------------------------------------------------------------------------------- |
| `forwardemail`               | Opens Forward Email.                                                                   |
| `forwardemail update`        | Updates to the latest version (`upgrade` works too).                                   |
| `forwardemail logout`        | Signs out and deletes the session and local data stored on this device.                |
| `forwardemail notifications` | Shows whether desktop notifications work here and what shows them. `--test` sends one. |
| `forwardemail help`          | Prints help.                                                                           |

| Option               | What it does                                                         |
| :------------------- | :------------------------------------------------------------------- |
| `--demo`             | Opens the demo account with sample mail, contacts and events.        |
| `--api <url>`        | Uses another API server, such as a self-hosted Forward Email.        |
| `--data-dir <path>`  | Keeps settings and the session in this directory (see below).        |
| `--no-update-check`  | Skips the daily update check.                                        |
| `--no-hints`         | Hides the key hints on the bottom row.                               |
| `--no-notifications` | Shows no desktop notifications. New mail still shows inside the app. |
| `-v`, `--version`    | Prints the version.                                                  |
| `-h`, `--help`       | Prints help, including where this machine keeps its data.            |

`forwardemail` needs an interactive terminal. Running it with input or output redirected exits with an error.

### Keys and mouse

The bottom row always shows the keys for what is on screen, for example with a message open:

```text
Esc Back   r Reply   a Reply all   f Forward   e Archive   s Star   m Read/unread   Del Delete   ? Shortcuts
```

Click a hint to press its key. Press `?` for every shortcut. To change one, choose **Change keys in Settings** in the bar while that list is open, or go to **Settings › Keyboard Shortcuts**. There, choose **Edit** next to the shortcut and press the new key (Esc cancels). The hint bar and the `?` list show the new key straight away. Hide the bar with `--no-hints`.

What you type right after a new-message, reply or forward shortcut (Ctrl+N, `r`, `a`, `f`, or the keys you gave them) goes into the new message, even before its window has appeared.

| Key                 | Action                                                                           |
| :------------------ | :------------------------------------------------------------------------------- |
| `Tab` / `Shift+Tab` | Move between controls, starting from where you clicked. Focus is highlighted.    |
| `Enter` / `Space`   | Activate the focused button or link.                                             |
| `↑` / `↓`           | Open the next or previous message, counting from the focused row in the list.    |
| `Esc`               | Close a dialog or menu; otherwise go back (from a message, a contact, settings). |
| `Ctrl+N`            | Compose a new message.                                                           |
| `r` / `a` / `f`     | Reply, reply all, forward.                                                       |
| `e` / `s` / `Del`   | Archive, star, delete.                                                           |
| `?`                 | Show every keyboard shortcut.                                                    |
| `Ctrl+C`            | Copy the selected text; with nothing selected, quit (after asking).              |

Opening a message moves the keyboard into it, so `Tab` goes through its buttons and addresses. Going back to the list puts the focus on that message's row.

`forwardemail` uses the terminal's alternate screen, as `vim` and `less` do. The wheel scrolls the app, not your shell's history, and quitting puts your shell's screen back as it was.

A scroll bar on the right edge of the message list, a message, the compose window and other long panes shows when there is more to see. Click the bar above or below its thumb to scroll a page, or drag the thumb. In the compose window the message grows as you type, the window scrolls to keep the cursor in view, and the arrow keys scroll it back.

Clicking and scrolling with the wheel work with the mouse in any terminal that reports mouse events. That includes most modern terminals: iTerm2, Terminal.app, GNOME Terminal, Konsole, kitty, WezTerm, Alacritty, foot and Windows Terminal. A terminal of 120 columns or more shows the full desktop layout. At 80 columns or fewer (the webmail's 640 px phone breakpoint), the folder list moves behind the `≡` menu, as on a phone.

Drag over text, in a message or anywhere else, to select it, then press `Ctrl+C` to copy it. The bottom row shows **Ctrl+C Copy** while text is selected. A click on an address in an open message copies the address. A copy goes to your clipboard two ways: through the system's clipboard program (`pbcopy` on macOS, PowerShell or `clip.exe` on Windows and in WSL, `wl-copy` under Wayland, `xclip` or `xsel` under X11), and through the terminal's clipboard sequence (OSC 52), the way that works over SSH. The app says **Copied** when the text got there. It says the copy failed when a clipboard program failed, or when none is installed and the terminal ignores OSC 52 (GNOME Terminal and the other VTE terminals, Terminal.app, the Linux console). On Linux, install `wl-clipboard` or `xclip` for copies in those terminals. Over SSH, the terminal has to accept OSC 52: in tmux, add `set -g set-clipboard on` (or `set -g allow-passthrough on`); iTerm2 asks first, allow it under **Settings › General › Selection › Applications in terminal may access clipboard**. To use your terminal's own selection instead, hold its modifier while you drag: Option in iTerm2, Fn in Terminal.app, Shift in most others.

With the pointer on a button, the bottom row shows the button's name. Ghostty, kitty, WezTerm and foot also change the pointer to a hand over links and buttons and to an I-beam over text fields. `FORWARDEMAIL_POINTER=1` asks other terminals to do the same, and `FORWARDEMAIL_POINTER=0` stops it.

Links in messages, and links to other sites, open in your default browser. Files you save (attachments, exported contacts and calendars, a message as `.eml`) go to your Downloads folder, and a notice shows where.

### Plain text

Messages are shown, and new messages written, as plain text by default in the terminal. A reply quotes the original with `>` in front of each line. The **T** button next to **Save draft** in the compose window switches that message to rich text, with the formatting toolbar, and back. To change the default, use **Settings › Appearance › Use plain text by default** and **Settings › Privacy & Security › View emails as plain text**. The browser, desktop and mobile apps keep rich text as their default.

### Notifications

New mail that arrives while the terminal is in the background shows as a desktop notification, as it does in a browser tab you are not looking at. While you are using the terminal, it shows inside the app instead. Calendar reminders work the same way.

Turn them on in **Settings › Account › Notifications › Allow notifications**, or with **Turn on** in the offer the app shows once after you sign in. **Turn off notifications** in the same place turns them off again. `forwardemail notifications --test` sends a test notification from the command line.

| System  | Shown by                                                                                                                                                                                                                                                                                                                                 |
| :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Notification Center, through [terminal-notifier](https://github.com/julienXX/terminal-notifier) (included). Clicking one brings your terminal to the front. Allow it in System Settings › Notifications if macOS asks. terminal-notifier is an Intel program, so Apple Silicon Macs need Rosetta 2 (`softwareupdate --install-rosetta`). |
| Linux   | Your desktop's notification service, through `notify-send` (package `libnotify-bin` on Debian and Ubuntu, `libnotify` on Fedora and Arch).                                                                                                                                                                                               |
| Windows | Windows notifications, through [ntfytoast](https://github.com/Aetherinox/ntfy-toast) (included). Clicking one opens the message.                                                                                                                                                                                                         |

The client knows whether its terminal is in the foreground from the terminal's focus reports, which most terminals send. In tmux, add `set -g focus-events on` to `~/.tmux.conf`. A terminal that sends no focus reports counts as in the background after two minutes without a key press or mouse event.

Notifications are off over SSH, since they would appear on the remote computer, and on Linux without a desktop session. `FORWARDEMAIL_NOTIFICATIONS=1` turns them on anyway, and `FORWARDEMAIL_NOTIFICATIONS=0` (or `--no-notifications`) turns them off everywhere. Notifications come from the running app: nothing arrives after you quit it.

### Environment variables

| Variable                       | Effect                                                                               |
| :----------------------------- | :----------------------------------------------------------------------------------- |
| `FORWARDEMAIL_HOME`            | Same as `--data-dir`: the directory for settings and the session (see below).        |
| `FORWARDEMAIL_API_URL`         | Same as `--api`.                                                                     |
| `FORWARDEMAIL_NO_UPDATE_CHECK` | Same as `--no-update-check`.                                                         |
| `FORWARDEMAIL_NO_HINTS`        | Same as `--no-hints`.                                                                |
| `FORWARDEMAIL_NOTIFICATIONS`   | `0` is the same as `--no-notifications`. `1` shows them over SSH too.                |
| `FORWARDEMAIL_POINTER`         | `1` asks any terminal to change the pointer shape, `0` none (see above).             |
| `FORWARDEMAIL_DOWNLOADS`       | Where saved files go, instead of `~/Downloads` (or your home directory without one). |
| `FORWARDEMAIL_DEBUG`           | Writes the app's console output to `forwardemail.log` in the data directory.         |

### Where data is stored

| System  | Default directory                                                             |
| :------ | :---------------------------------------------------------------------------- |
| Linux   | `$XDG_CONFIG_HOME/forwardemail`, or `~/.config/forwardemail` if that is unset |
| macOS   | `~/Library/Application Support/forwardemail`                                  |
| Windows | `%APPDATA%\forwardemail`                                                      |

To keep the data somewhere else, such as an encrypted volume or a synced folder, pass `--data-dir <path>` or set `FORWARDEMAIL_HOME`. A leading `~` means your home directory, and the directory is created on first use. Use the same setting each time you run `forwardemail` (an alias such as `alias forwardemail='forwardemail --data-dir ~/secure/forwardemail'` helps), since each directory holds its own session. `forwardemail --help` prints the directory in use.

| File                 | Contents                                                                                                                                                                    |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-storage.json` | What the webmail keeps in a browser's `localStorage`: your session and settings. Readable only by you (mode `0600`). It holds the same data as a signed-in browser profile. |
| `update.json`        | When updates were last checked.                                                                                                                                             |
| `notifications.json` | Whether you allowed desktop notifications.                                                                                                                                  |
| `notifier/`          | The standalone executable writes its notifier files here (the notifier program on macOS and Windows, the app icon) the first time it needs them.                            |
| `user.css`           | Optional styles of your own (see below).                                                                                                                                    |
| `forwardemail.log`   | Debug log, only written with `FORWARDEMAIL_DEBUG=1`.                                                                                                                        |

Mail, contacts and the search index are cached in memory for the session. So are drafts and changes made while the network is down: they are sent when the connection is back, which the client checks every few seconds. Quitting before then loses them. Like the webmail, they are fetched again from the server when you start the app. `forwardemail logout` removes `local-storage.json`, `update.json`, `notifications.json`, `notifier/` and `forwardemail.log`, and leaves `user.css` alone. Downloads go to your Downloads folder, not here.

### Custom styles

Put CSS in `user.css` in the data directory to restyle the terminal client. It is loaded after the built-in styles. Lengths are written in browser units: one column is `8px` (`0.5rem`) and one row is `16px` (`1rem`). Colors are drawn in true color where the terminal supports it.

```css
/* An amber accent for buttons, links and the focused control */
:root,
.dark {
  --fe-primary: #b45309;
}

/* Hide the storage meter in the sidebar */
a[href$='/my-account/billing'] {
  display: none;
}
```

### Self-hosted servers

The terminal client talks to `https://api.forwardemail.net` by default. To use a self-hosted Forward Email instance, point it at that server's API:

```sh
forwardemail --api https://api.mail.example.com
# or
export FORWARDEMAIL_API_URL=https://api.mail.example.com
```

## Updates

**Standalone executables update themselves.** At most once a day, `forwardemail` checks the latest GitHub release in the background while you use it. If there is a newer version, it downloads the build for your system, verifies its SHA-256 checksum against the release's `SHA256SUMS.txt`, and replaces the executable atomically. The new version runs the next time you start the app, and a one-line note is printed when you quit. To update right away, run `forwardemail update`.

**npm installs** check the same way but do not change anything themselves. When an update is available, a note on exit says to run `forwardemail update`, which runs `npm install -g forwardemail@latest`.

Turn the check off with `--no-update-check` or `FORWARDEMAIL_NO_UPDATE_CHECK=1`. A failed check (offline, rate-limited) is silent and is retried at the next start.

## Verifying downloads

Every release lists the SHA-256 of each asset in `SHA256SUMS.txt`, and each executable has a [GitHub build provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds). Together they show that the file was built by this repository's release workflow from the tagged source.

```sh
# The checksum (the installers and the updater do this for you)
grep forwardemail-linux-x64.gz SHA256SUMS.txt | sha256sum -c -

# The provenance, with the GitHub CLI
gh attestation verify forwardemail-linux-x64.gz --repo forwardemail/mail.forwardemail.net
```

The Windows executables are also Authenticode-signed by Forward Email LLC with the same certificate as the desktop installers. In PowerShell, `Get-AuthenticodeSignature forwardemail.exe` shows the signer.

The npm package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). Run `npm audit signatures` after installing to check it.

## Uninstall

Sign out first, so no session is left behind, then remove the program:

```sh
forwardemail logout
rm ~/.local/bin/forwardemail      # standalone, macOS and Linux
npm uninstall -g forwardemail     # npm
```

On Windows, delete `%LOCALAPPDATA%\Programs\forwardemail` and remove it from your user `PATH`. To remove every trace, also delete the data directory listed under [Where data is stored](#where-data-is-stored).

## Differences from the browser

The terminal client runs the webmail's own code, so features behave the same way they do on the web. These are the exceptions, all due to what a terminal can draw:

- **Images, video and canvas** are not drawn. Icons appear as text glyphs, and messages are shown as formatted text with their links.
- **Plain text** is the default for reading and writing (see [Plain text](#plain-text)).
- **Fonts and font sizes** are the terminal's. Headings stand out by weight and color, not size.
- **Passkeys** (WebAuthn) need a browser or the desktop app. To use App Lock in the terminal, unlock it with its PIN.
- **Push notifications and the service worker** are unavailable. New mail arrives over the WebSocket connection while the app is open, and shows as a [desktop notification](#notifications) when the terminal is in the background.
- **Hover tooltips** appear in the bottom row rather than over the page, where they would cover the controls around them.
- **Transparency and animation** are flattened: translucent colors are blended with the page background, and transitions jump to their end.
- **Esc followed by a key** in quick succession counts as two presses, not as Alt plus the key (some terminals send Alt that way). The exceptions are Alt+Backspace and Alt+B/F/D, which keep their word-editing meaning in text fields. The webmail has no other Alt shortcuts.

## Troubleshooting

**The layout is garbled or characters overlap.** Use a font with box-drawing characters and a terminal that supports Unicode. On Windows, use Windows Terminal rather than the legacy console.

**Colors look wrong.** Set `COLORTERM=truecolor` if your terminal supports 24-bit color but does not advertise it. Inside tmux, add `set -g default-terminal "tmux-256color"` and `set -as terminal-features ",*:RGB"`.

**Clicks do nothing.** Turn on mouse reporting in your terminal (in tmux: `set -g mouse on`). Keyboard navigation always works.

**No desktop notifications.** Run `forwardemail notifications --test`. It says why they are off (for example over SSH, or `notify-send` missing on Linux) or sends a test. Check that they are turned on in **Settings › Account › Notifications**, and that your system allows them for terminal-notifier (macOS) or NtfyToast (Windows).

**`forwardemail: command not found` after installing.** Add the install directory to your `PATH`. For the default on macOS and Linux:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
```

**Something else is wrong.** Run `FORWARDEMAIL_DEBUG=1 forwardemail`, reproduce the problem, and attach `forwardemail.log` from the data directory to an [issue](https://github.com/forwardemail/mail.forwardemail.net/issues). Check the log for anything private before posting it.

## How it works

The webmail is built a second time for Node.js, and the result is a single CommonJS file, `cli/dist/forwardemail.cjs`:

1. **App bundle.** [`vite.cli.config.js`](../vite.cli.config.js) builds `src/main.ts` with the same Svelte components, stores and workers as the web build. Lucide icons are swapped for text glyphs ([`src/cli/components/LucideIcon.svelte`](../src/cli/components/LucideIcon.svelte)). The stylesheets are collected into one string.
2. **Stylesheet conversion.** [`scripts/build-cli.mjs`](../scripts/build-cli.mjs) drops what a terminal cannot draw: animations, shadows, fonts, print styles and unused custom properties ([`src/cli/prune-css.js`](../src/cli/prune-css.js)). It then converts lengths to terminal cells ([`src/cli/px-to-cells.js`](../src/cli/px-to-cells.js)). The app sees a window 8 px per column and 16 px per row, so its media queries and layout code work unchanged. [`src/cli/terminal.css`](../src/cli/terminal.css) adds terminal-specific rules on top: focus highlighting, one-row inputs and hidden images. [`src/cli/terminal-utilities.css`](../src/cli/terminal-utilities.css) goes inside Tailwind's utilities layer, so the app's responsive variants (`md:hidden`) still override it.
3. **Launcher.** [`src/cli/index.ts`](../src/cli/index.ts) handles the command line and updates, then [`src/cli/app.ts`](../src/cli/app.ts) boots the page. [`src/cli/environment.ts`](../src/cli/environment.ts) makes Node look like the browser tab the webmail expects:
   - a TermDOM `window` and `document`
   - `localStorage` saved to disk
   - IndexedDB from `fake-indexeddb`
   - Web Workers on `worker_threads` ([`src/cli/worker.ts`](../src/cli/worker.ts))
   - `history` and `location` ([`src/cli/history.ts`](../src/cli/history.ts))
   - sandboxed message frames ([`src/cli/frames.ts`](../src/cli/frames.ts))
   - downloads and outside links ([`src/cli/links.ts`](../src/cli/links.ts))
   - geometry scaled to the virtual pixel grid ([`src/cli/viewport.ts`](../src/cli/viewport.ts))

The application code under `src/` is untouched. Everything specific to the terminal lives in `src/cli/`, and the browser and desktop builds do not include it.

The standalone executables are [Node.js single executable applications](https://nodejs.org/api/single-executable-applications.html): the bundle is injected into a copy of the `node` binary by [`scripts/build-sea.mjs`](../scripts/build-sea.mjs).

## Development

```sh
pnpm install
pnpm build:cli                  # cli/dist/forwardemail.cjs
pnpm cli --demo                 # run the build
pnpm test:cli                   # build, then run tests/cli
pnpm build:sea                  # standalone executable for this machine in cli/dist/
```

`CLI_BUILD_DEV=1 pnpm build:cli` builds with `import.meta.env.DEV` set. `FORWARDEMAIL_DEBUG=1` logs console output and focus changes to `forwardemail.log`. `FORWARDEMAIL_DEBUG_DOM=<file>` writes the document's markup to a file every two seconds, which helps when a layout does not match the browser.

The interactive tests in [`tests/cli/cli.e2e.test.js`](../tests/cli/cli.e2e.test.js) run the built client in a real pseudo-terminal (util-linux `script`) and read the screen through a headless xterm.js, as a user's terminal would. They click, type and wait for text on screen. They run on Linux; on other systems only the command-line tests run.

When a component looks wrong in the terminal, fix it in `src/cli/terminal.css`, or in the stylesheet conversion when the cause is general, rather than in the component. That keeps the web and desktop apps unchanged.

## Releasing

The CLI shares the app's version and is released with it: nothing extra to run. `pnpm release` (np) bumps `cli/package.json` along with the rest, commits, and pushes the `v*` tag; the build fails if the two versions differ. np itself does not publish to npm (`"publish": false`); CI publishes the package it built and tested.

For every `v*` tag, [`release.yml`](../.github/workflows/release.yml) calls [`release-cli.yml`](../.github/workflows/release-cli.yml), which:

1. builds and checks the bundle;
2. builds the six standalone executables on native runners, smoke-tests each one, and uploads them gzipped with provenance attestations;
3. uploads `install.sh` and `install.ps1`;
4. publishes the npm package `forwardemail` at the same version, with [provenance](https://docs.npmjs.com/generating-provenance-statements). A prerelease version (`1.2.0-beta.1`) goes to the `next` dist-tag, as np would publish it.

`SHA256SUMS.txt` is written afterwards by the release's checksums job. The installers and the updater find the release through GitHub's `releases/latest`, so they only see a release after it is published (not while it is a draft or prerelease).

To rebuild the CLI assets of an existing release, run **Release CLI** from the Actions tab with the version, then re-run the release's checksums job. A version already on npm is left as it is (npm versions cannot be replaced).

Before the first release, give the workflow a way to publish to npm. The `forwardemail` package already exists there, so the simplest is [trusted publishing](https://docs.npmjs.com/trusted-publishers): on the package's settings page on npmjs.com, add GitHub Actions with organization `forwardemail`, repository `mail.forwardemail.net`, workflow `release.yml` and environment `release`. No secret is needed then. A manual **Release CLI** run is not covered by that (npm checks the workflow that started the run) and needs an `NPM_TOKEN`. [Secrets › npm publishing](./SECRETS.md#npm-publishing-for-the-terminal-client) has both setups step by step.

If neither is set up, the npm job fails, and with it the release run's summary; the GitHub release and its executables are published regardless. Set one up and re-run **Release CLI** for that version.

A manual run for a version older than npm's `latest` publishes it under the `previous` dist-tag, so `latest` never moves backwards.

| Setting                                                                                | Kind     | Purpose                                                                                                                                                     |
| :------------------------------------------------------------------------------------- | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                                                                            | Secret   | npm granular token, in the `release` environment. Not needed with trusted publishing, except for manual **Release CLI** runs.                               |
| `ESIGNER_USERNAME`, `ESIGNER_PASSWORD`, `ESIGNER_CREDENTIAL_ID`, `ESIGNER_TOTP_SECRET` | Secrets  | Sign the Windows executables with the same SSL.com eSigner certificate as the desktop installers; see [Secrets](./SECRETS.md#windows-code-signing-secrets). |
| `ALLOW_UNSIGNED_WINDOWS`                                                               | Variable | Shared with the desktop release: `true` ships the Windows executables unsigned when the eSigner secrets are missing, instead of failing.                    |
