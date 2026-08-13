# Architecture

## Stack

```
Electron main process (main.js)
  │  boots the HTTP server in-process, opens a BrowserWindow at its port
  ▼
Express server (server.js) ── bound to 127.0.0.1 only, no auth (offline single-operator tool)
  │
  ├── db/  ── node:sqlite (DatabaseSync) — local file, zero native deps
  │           schema.js, pool.js, campaigns.js, sessions.js, settings.js
  │
  └── wa/  ── the automation layer
              audience.js     — CSV parsing, phone normalisation
              attachments.js  — Google Drive link normalisation + reachability checks (no download)
              desktop.js      — platform dispatcher (process.platform → win/mac backend)
              desktop.win.js  — PowerShell/Win32 keyboard automation of WhatsApp Desktop (Windows)
              desktop.mac.js  — osascript/System Events keyboard automation (macOS, UNVERIFIED)
              verify.js       — the composer-verification similarity oracle, shared by both backends
              overlay.js      — always-on-top progress window (Electron BrowserWindow, cross-platform)
              sender.js       — orchestrates a campaign run: pacing, daily cap, retries, link preflight
                                 (platform-agnostic — talks only to wa/desktop.js's dispatcher)

public/index.html — the entire frontend: one static file, no build step, no framework
public/overlay.html — content for the always-on-top progress window
template.js — the message template default + {{placeholder}} fill logic
update-status.js — Windows auto-update / macOS manual-update state, bridged to the renderer
platform-status.js — macOS Accessibility-permission state, bridged to the renderer
```

**Why no browser automation (Puppeteer/whatsapp-web.js/Baileys)?** See
[decisions.md](decisions.md) — in short, this app drives the real WhatsApp desktop app via
keyboard automation, not a browser session, because the CSV contacts only resolve correctly
through a real desktop app instance.

**Two platform backends behind one contract.** `wa/sender.js` and `server.js` call
`wa/desktop.js`'s 15-function contract (`focus`, `openChatByNumber`, `pasteIntoComposer`,
`verifyComposer`, …) without knowing which OS is running — the dispatcher in `desktop.js`
`require()`s `desktop.win.js` or `desktop.mac.js` based on `process.platform`, and neither
backend is even parsed on the other OS. `wa/sender.js` itself has **zero** platform-specific
code, which is what made this split possible without touching the orchestration logic at
all. See [decisions.md](decisions.md) for why the macOS backend uses `osascript` rather than
a native automation module, and why it ships labeled unverified.

**Why Electron wraps a plain Express server rather than using Electron's own IPC?** The
server also runs standalone via `node server.js` for local development — `npm run electron`
and the packaged app both just boot the same server in-process and point a window at
whatever port it picked. This means `public/index.html` needs zero Electron-specific code
and could be opened in a plain browser during development.

## Data model

SQLite, one file, at `app.getPath('userData')` in the packaged app (falls back to
`./data/*.sqlite3` for `node server.js`). All timestamps are `INTEGER` epoch-milliseconds
(`Date.now()`), not SQL date types — this makes "last 24 hours" filters a plain numeric
comparison and avoids SQLite's text-based date functions entirely.

| Table | Purpose |
|---|---|
| `wa_sessions` | Sender numbers the operator has confirmed. **Not** a WhatsApp login — WhatsApp Desktop owns its own session entirely; this table only labels which number is "active" for daily-cap tracking. |
| `campaigns` | One row per CSV upload. `status`: `draft` → `running` → `done` / `aborted`. |
| `recipients` | One row per CSV row, keyed by `(campaign_id, sno)`. `state`: `pending` → `submitted` / `unknown` / `skipped`. `sno` always means "line N of the operator's own CSV" — rows are never renumbered or dropped, only marked skipped. `poster_link`/`brochure_link` (nullable) carry a per-row override from an optional `POSTER LINK`/`ATTACHMENT LINK` CSV column. |
| `settings` | Plain key/value. Pacing, daily cap, default country code, the message template + name fallback, and the event-level `posterLink`/`brochureLink` fallback — everything a non-technical operator can tune from the UI, none of it in `.env` (a packaged app's install directory is read-only, so `.env` would be unreachable). |

Foreign keys are enforced (`PRAGMA foreign_keys = ON`, set per-connection since SQLite
disables this by default) — deleting a campaign cascades to its recipients.

`recipients.poster_link`/`brochure_link` were added after release via a **guarded migration**
(`db/schema.js`'s `migrateAddColumnIfMissing`) rather than editing the base `CREATE TABLE`
directly — `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so an
in-place DDL edit would have broken every install with a live database. Checks
`PRAGMA table_info` before `ALTER TABLE ... ADD COLUMN`; every future schema change should
follow the same pattern.

## HTTP API

All routes are local-only (`127.0.0.1`), JSON in/out except the CSV upload (multipart) and
the send route (NDJSON stream).

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness check. |
| GET | `/api/settings` | Current pacing/cap/country/template settings (merged with defaults). |
| POST | `/api/settings` | Partial update — merges over current settings, validates, persists. |
| GET | `/api/template/default` | The built-in default message, for the editor's "Reset to default". |
| GET | `/api/numbers` | List configured sender numbers, with live `ready`/`app_not_running` status. |
| POST | `/api/numbers` | Register a sender number. |
| DELETE | `/api/numbers/:id` | Remove a sender number. |
| POST | `/api/campaigns` | Upload a CSV (multipart, field `file` + `senderId`) → creates a campaign and its recipients in one transaction. |
| GET | `/api/campaigns/:id` | Campaign + all its recipients. |
| DELETE | `/api/campaigns?senderId=` | "Start over" — purges all campaigns (and cascaded recipients) for one sender. |
| POST | `/api/campaigns/:id/send` | Body `{ snos: number[] }`. Streams NDJSON progress, one line per event. Rejects with 409 if a send is already running (only one at a time, system-wide). |
| POST | `/api/campaigns/:id/abort` | Cooperative abort of the campaign's active send. 404 if nothing is running for that id. |

### The send stream

`POST /api/campaigns/:id/send` responds with `Content-Type: application/x-ndjson` — one JSON
object per line, flushed as the run progresses:

```
{"sno":1,"name":"Priya","phone":"919...","state":"submitted","error":null}
{"type":"pause","ms":153000}
{"sno":2,"name":"Rahul","phone":"919...","state":"unknown","error":"send failed: ..."}
{"type":"aborted","reason":"3 consecutive failures — stopping"}
```

Per-recipient events carry `state` (`submitted` | `unknown` | `skipped`); the `type`-only
events (`pause`, `aborted`, `error`, `warning`) are progress/control signals with no recipient
attached. `warning` is emitted by the poster/brochure link preflight (see below) — non-fatal,
surfaced in the log terminal, never stops the run.

## Send-loop state machine (`wa/sender.js`)

```
runCampaign()
  → settingsDb.getSettings()        (read fresh — a mid-run settings edit is deliberately
                                      NOT picked up until the next run starts)
  → preflightAttachments()           (BEFORE focusing WhatsApp — pure network I/O)
      → every DISTINCT poster link (per-row override, else the event-level setting) is
        DOWNLOADED once via wa/attachments.js and cached to disk — not once per
        recipient, since a shared event-level poster means a dead link would otherwise
        fail identically on every recipient using it.
      → every distinct brochure link gets a HEAD reachability check (warns, never
        blocks) plus a one-time TinyURL shortening of the raw Drive share link — a
        shortening failure falls back silently to the original link, no warning.
  → desktop.focus()                 (throws → stoppedEarly: "focus_failed", 0 sends)
  → overlay.start()
  → for each recipient:
      skip if already 'skipped', or daily cap reached, or operator aborted
      → resolve this row's effective poster/brochure link (row's own CSV value wins,
        settings value is the fallback); append "View Brochure: <url>" to the text
        when configured (the poster is NOT appended as text — see below)
      → sendOne(phone, text, dryRun, posterLocalPath):
          resetToCleanState → openChatByNumber →
          POSTER path: setClipboardImage → pasteImage → pasteCaption(text) →
            verifyComposer(text) (ONE retry of the whole attach sequence on failure)
            → verified? pressEnterToSend, report 'submitted'
          NO POSTER: pasteIntoComposer → verifyComposer (ONE retry on failure)
            → verified? pressEnterToSend, report 'submitted'
          → not verified after retry, either path? discard/clear, report 'unknown'
      → persist result, emit NDJSON event, update the overlay
      → 3 consecutive failures → stoppedEarly: "consecutive_failures", loop ends
      → pace: short random delay, or a longer pause every `sendBatchSize` sends
        (abort-aware — checked every 500ms during a pause, not just between sends)
  → overlay.stop(), restore the operator's original clipboard
  → return { stoppedEarly, reason }
```

The poster is a real attached image, sent via clipboard paste (`CF_DIB` /
`Clipboard.SetImage`) — confirmed working with a real send watched arrive on a real WhatsApp
Desktop install, after link-preview delivery was tried first and proven impossible (the Drive
page has no `og:image` metadata for WhatsApp to unfurl). See [decisions.md](decisions.md) for
the full account, including an invalid test that first produced the wrong conclusion here.
**One honest limit:** `verifyComposer` after `pasteCaption` only confirms the caption text
landed correctly — it cannot confirm the image itself is attached, since no reliable clipboard
readback exists for that (the same reason the earlier detection attempt was invalid). A
caption-only failure (wrong chat, lost focus) is still caught; a silently-missing image with a
correct caption is not.

`server.js` combines `stoppedEarly` with the operator abort flag to persist the campaign's
real final status (`done` only if it actually completed; `aborted` for every other exit,
including an internal stop that isn't operator-triggered).

## Why keyboard automation, and how the desktop backends work

WhatsApp Desktop publishes **nothing** to Windows UI Automation — a maximised, focused
window has exactly 8 descendant elements (title-bar chrome only), verified directly. There
is no chat list, no composer, no message bubbles to find or click. Every interaction is
therefore blind keystrokes via `SendKeys`, sent through a spawned `powershell.exe` process
(no new dependency — everything needed ships with Windows).

- **Focus is asserted by owning process ID**, never window title text — a Chrome tab titled
  "WhatsApp" would match a naive title regex and silently steal keystrokes.
- **The message is verified before Enter is ever pressed**: overwrite the clipboard with a
  one-time sentinel, select-all + copy from whatever holds focus, and compare what comes
  back against the source text (position-wise similarity, not exact equality — WhatsApp's
  own rich-text autoformatting, e.g. `- ` → `* `, means exact equality is the wrong bar even
  after line-ending normalisation). This oracle (`wa/verify.js`) is shared, unchanged, by
  both platform backends.
- **Delivery is never verified** — only that a real composer accepted the paste. Every send
  reports `submitted`, never `sent`/`delivered`. See [decisions.md](decisions.md) for why
  post-send verification was tried and abandoned.
- Non-ASCII text (curly quotes, emoji, accents) crosses the PowerShell boundary as
  **base64(UTF-16LE)**, not raw text — PowerShell's stdout goes through the console
  codepage, which silently corrupts anything outside ASCII otherwise.
- Every PowerShell invocation has a 20-second timeout with a `child.kill()` — a PowerShell
  process blocked on a contended clipboard (common with Office, RDP, or clipboard managers
  running) would otherwise hang the promise, and the whole send loop, forever.

### macOS backend (`wa/desktop.mac.js`) — UNVERIFIED

Mirrors the Windows design exactly, one level down: `osascript` (System Events) replaces
PowerShell/Win32, and `pbcopy`/`pbpaste` replace `Set-Clipboard`/`Get-Clipboard`. Because
macOS pipes are UTF-8, the base64(UTF-16LE) smuggling above has **no macOS equivalent** —
text goes through `pbcopy`/`pbpaste` directly. Foreground identity is asserted by **bundle
identifier**, the same anti-spoofing principle as the Windows PID check. `focus()` is
simpler than Windows: macOS has no foreground-lock/UAC problem, so there is no
`AttachThreadInput` equivalent — a plain `activate` plus a verify-and-retry loop is enough.

This file was written on a Windows machine with no Mac available to test against — every
keystroke mapping (Cmd+N for New Chat, etc.) is based on published WhatsApp for Mac
shortcuts, and every `TIMINGS` delay is a starting guess seeded from the tuned Windows
values, not a measurement. `npm run mac:doctor` (`scripts/mac-doctor.js`) is the intended
first thing to run on a real Mac: it walks each primitive against a real chat, step by step,
so the eventual tuning pass is short. See [decisions.md](decisions.md) for the reasoning
behind shipping it this way rather than waiting.

## Build & release

- `npm run electron` — run the packaged-app code path locally via `electron .`.
- `npm run dist` — build an unsigned installer for whatever OS this runs on
  (`electron-builder`; NSIS on Windows, dmg+zip on macOS) into `dist/`, without publishing.
  Unsigned is a deliberate cost tradeoff on both platforms — see [decisions.md](decisions.md).
- `npm run release` — same build, but publishes it as a GitHub Release (`--publish always`).
  Requires a `GH_TOKEN` with repo access in the environment — this is the manual, single-OS
  path; normally CI builds and publishes both platforms together (below).
- `npm run mac:doctor` — macOS-only interactive harness (`scripts/mac-doctor.js`) that walks
  every `wa/desktop.mac.js` primitive against a real chat, one step at a time. The intended
  way to turn the macOS backend from "written but unverified" into something trustworthy.

**Releasing is automatic on a version bump.** `.github/workflows/release.yml` runs on every
push to `main` (repo is public, so Actions minutes are free, including the `macos-latest`
runner). It reads `version` from `package.json` and checks whether a GitHub Release for
`v<version>` already exists — if so, it exits doing nothing, which is what makes an ordinary
commit (docs, a fix) ship nothing. If the version is new, a `build-windows` job and a
`build-macos` job run in parallel, each producing its own artifacts (electron-builder's own
GitHub publisher was tried and dropped — it raced itself into two draft releases for one
tag), and a final `release` job downloads both artifact sets and does one atomic
`gh release create` with everything attached. **To ship an update: bump `version` in
`package.json`, commit, push.** Nothing else.

### Windows: automatic, visible updates

Every installed Windows copy checks for updates on launch and after each campaign run ends
(`main.js`'s `checkForUpdates`), downloads in the background, and installs on the next quit
even if the user never touches it. `update-status.js` is written by `main.js`'s `autoUpdater`
event handlers (`checking-for-update`, `update-available`, `download-progress`,
`update-downloaded`, `error`) and read by `GET /api/update-status` (`server.js`) — the
renderer polls this (every 30s idle, every 1s while downloading/checking, since there's no
IPC/preload channel to push it directly) and shows a banner under the header: progress while
downloading, then a "Restart & install now" button once downloaded, which calls
`POST /api/update-install` → `events.emit("install-update")` →
`autoUpdater.quitAndInstall(true, true)` in `main.js`.

### macOS: manual, notify-only updates

macOS **cannot** use this mechanism: `electron-updater`'s macOS path (Squirrel.Mac) hard-
requires a valid Developer ID code signature, and this app is unsigned (see
[decisions.md](decisions.md) — no paid Apple account). CI never publishes a
`latest-mac.yml`, so there's no feed for `electron-updater` to even attempt on macOS.
Instead, `main.js`'s `checkForUpdatesMac()` calls the GitHub Releases API directly, compares
the latest tag against `app.getVersion()`, and — if newer — sets `update-status.js` to
`manual-available`. The same banner shows "Update vX.Y.Z available — Download", which calls
`POST /api/update-open` → `shell.openExternal` to the release page; the user re-installs the
`.dmg` by hand.

### Accessibility permission (macOS only)

Unlike Windows, macOS gates keystroke automation (`System Events keystroke`) behind the
Accessibility privacy permission — this app cannot send a single message on a Mac without
it. `main.js` polls `systemPreferences.isTrustedAccessibilityClient(false)` at launch and
every 5s until granted, writing the result to `platform-status.js` (same bridge pattern as
`update-status.js`). `GET /api/platform-status` exposes it; the frontend shows a blocking
card with a "Grant access" button (`POST /api/request-accessibility`) that prompts and
deep-links to System Settings → Privacy & Security → Accessibility. On Windows this state is
always `null` and the card never renders.

### Both platforms

- The database path is set explicitly (`app.setName("whatsapp-blaster")`, called before
  `app.getPath('userData')` is ever read) so it can never drift if `productName` changes in
  a future edit — this is what keeps a user's saved settings and message template intact
  across updates.
- `build/afterPack.js` ad-hoc re-signs the packed macOS `.app` (`codesign --sign -`) after
  electron-builder packs it — Apple Silicon refuses to launch a completely unsigned app
  ("damaged and can't be opened"), and `identity: null` alone doesn't add even that minimal
  signature.
