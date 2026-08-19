# Decision log

Why the app is built the way it is — the reasoning behind choices that aren't obvious from
reading the code alone, in roughly the order they were made. Sourced from the project's
planning history and code comments, which were previously the only record of this.

## The sending mechanism: four architectures, three abandoned

The original plan (like the sibling RYS Email Blaster) called for a library-driven approach:
**Baileys**, an unofficial WhatsApp Web protocol library, chosen because it was the only
zero-cost route that could actually send to a list at the time. This was abandoned during
implementation and testing in favour of, in order:

1. **Baileys** → dropped. Real WhatsApp Web protocol session management proved too fragile
   for this use case in practice.
2. **whatsapp-web.js** (Puppeteer wrapping a real WhatsApp Web session) → dropped.
3. **Raw Puppeteer DOM automation of web.whatsapp.com** → dropped. Testing surfaced that
   contacts in this operator's CSV only resolved correctly when opened through the real
   WhatsApp **Desktop** app — not through a WhatsApp Web browser session, even a real one.
   That's a hard requirement, not a preference, and it ruled out every browser-based
   approach.
4. **WhatsApp Desktop keyboard automation (PowerShell/Win32)** → the final, current
   architecture. Drives the actual Windows Store app directly, the same way a human operator
   would, via `SendKeys` and clipboard operations. See [architecture.md](architecture.md) for
   how this actually works.

A consequence worth stating plainly: this means **the app cannot run headless or on a
server** — it needs a real interactive Windows desktop session with WhatsApp Desktop open
and visible. That's why it shipped as an Electron desktop app rather than a web service.

## No contact-list searching — Ctrl+N only

An earlier version of the chat-opening logic tried a `whatsapp://` deep link first, which
resolved the number through WhatsApp's own contact-matching before landing on a chat. This
was removed on explicit request: it visibly searched through the operator's entire contact
history, which was flagged as unwanted and confusing behaviour ("why is it searching through
my contacts?"). The current, only mechanism is direct: Ctrl+N (new chat), type the digits,
Enter. Simple and deterministic — the digits typed are exactly what gets searched, every
time, with no opaque contact-resolution step in between.

## Post-send delivery verification was tried and abandoned

An earlier version tried to confirm a send actually went through by re-running the same
clipboard-sentinel select-all-and-copy trick *after* pressing Enter, expecting an empty
composer back. Measured directly: after Enter, the foreground window's *owning process ID*
changes on every single check (WhatsApp Desktop is WebView2-based internally, and sending
visibly shifts focus to a different internal surface — most likely the message transcript),
and `Get-Clipboard` came back `null` — not an empty string, `null` — meaning the copy
operation wasn't capturing plain text at all. This held true at every checkpoint out to 8+
seconds, ruling out a slow-clearing timing issue. It's a different UI region this technique
cannot safely read, and it was producing **false failure reports on sends that had actually
gone through**.

**Conclusion, now load-bearing throughout the app:** post-send delivery cannot be verified.
OCR was explicitly considered and ruled out (too fragile, too slow for a message-per-second
send loop). Every send is honestly reported as `submitted`, never `sent`/`delivered` — the
composer content *is* still verified, just *before* Enter is pressed, which is the check
that's actually reliable.

## The composer-verification clipboard-sentinel technique

Because WhatsApp Desktop exposes nothing to Windows UI Automation (a maximised, focused
window has exactly 8 descendant elements — title-bar chrome only, verified directly), there
is no element to read the composer's contents from directly. The workaround: overwrite the
clipboard with a one-time random sentinel string, send Ctrl+A then Ctrl+C from whatever
currently holds focus, and compare what comes back.

- Got the sentinel back → the copy produced nothing new → no editable field is focused (or
  it's empty) → **fail**.
- Got near-identical text back → a real text field holds the message → **pass**.
- Got anything else → an unexpected selection (e.g. the chat list) → **fail**.

The sentinel is load-bearing: without it, a failed copy would leave the *previous* paste
still on the clipboard and read as a false pass.

**Similarity, not exact equality.** WhatsApp's own composer applies rich-text
autoformatting as text lands in it — most notably, `- ` at the start of a line silently
becomes a bullet `* `. This is a real, intentional change to the composer's content, not a
copy artifact, diagnosed by dumping a real capture: a template line starting `- ` came back
starting `* `, one character different. Exact-string comparison made every real send
fail verification while passing single-line tests that never exercised this path. The fix:
position-wise similarity scoring (threshold 0.95) — a same-length, mostly-matching string is
what a legitimate paste with autoformatting looks like; empty, truncated, or unrelated
content is what a genuine failure looks like.

## Focus-stealing: the `AttachThreadInput` findings

`SetForegroundWindow` is refused by Windows (since Vista/UAC) whenever the calling process
isn't already the foreground process — which is every time this app tries to activate
WhatsApp Desktop from a background process. `AttachThreadInput` bonds the calling thread's
input state to the current foreground thread's, which makes Windows treat the activation as
coming from an already-related process and lets it through.

This was broken for an extended period by one specific bug: `GetCurrentThreadId` was
imported from `user32.dll` instead of `kernel32.dll` (it only exists in the latter). The
P/Invoke silently failed, leaving the thread ID null and `AttachThreadInput` a no-op — so
focus-stealing only ever worked by chance, when Windows happened to permit
`SetForegroundWindow` outright, and failed hard against an application like Chrome that
actively holds the foreground lock. Fixed by importing from the correct DLL.

**Foreground identity is asserted by owning process ID, not window title text.** A regex
like `/whatsapp/i` against the window title is a real trap: a Chrome tab titled "(11)
WhatsApp - Google Chrome" matches it too, which would let keystrokes fire into the browser
while the app believed WhatsApp Desktop was focused. `GetWindowThreadProcessId` plus a
process-ID comparison against WhatsApp's actual running process IDs cannot be fooled by tab
titles.

## Postgres → local SQLite

The original plan used a dual MySQL/Postgres data layer (mirroring the sibling email app),
tested locally then deployed to Render. That deployment path became irrelevant once the
send mechanism moved to WhatsApp Desktop automation: **this app can only ever run on a
real interactive Windows desktop with WhatsApp Desktop open**, which rules out a hosted
server entirely. There was also no longer a technical reason for a *shared* database once
cross-campaign deduplication was removed (see below) — that dedup was the only feature that
actually needed a database reachable from more than one machine.

`node:sqlite` (`DatabaseSync`), stable since Node 22.5 and bundled in Electron's runtime
Node with no version gap, was chosen over `better-sqlite3` or similar specifically because
it needs **zero packages and zero native compilation** — verified with a live round trip on
the target machine before committing to it. Since the Postgres driver was the app's only
native-ish dependency, dropping it means the packaged app contains no native modules at all,
eliminating the single most common cause of Electron packaging failure before it can occur.

## No cross-campaign deduplication

An earlier version searched a participant's name against contact/campaign history to avoid
re-messaging someone who'd already been contacted. Removed on explicit request, alongside
the deep-link removal above — it was flagged as unwanted, opaque behaviour. The tradeoff is
now handled narrowly instead: **within one uploaded CSV**, duplicate phone numbers are
caught and marked `skipped`; **across campaigns**, a participant can legitimately be
messaged again for a different event, so nothing blocks that.

## Why sends report "Submitted", never "Delivered"

Covered in full above (post-send verification). Repeated here because it's the single most
important thing for an operator to understand: **this is a permanent limitation of the
mechanism, not a bug to be fixed later.** WhatsApp Desktop gives this app no way to confirm
arrival at all.

## The poster image: dropped, tried three ways, and finally confirmed working

The original requirements plan specified "templated text as caption + poster image inline,"
with the brochure/form as auto-previewing links in the text. This was dropped during the
Baileys → whatsapp-web.js → Puppeteer → WhatsApp Desktop migrations, initially without an
explicit decision to do so — attaching an image via keyboard automation would mean scripting
the WhatsApp Desktop file picker and its preview/send dialog, a materially more fragile flow
than pasting text. When this drift was later audited against the original plan, **text-only
was explicitly confirmed as the actual requirement and formally closed** — then reopened once
an actual event CSV (`POSTER LINK` / `ATTACHMENT LINK` columns, Google Drive share links) made
the requirement concrete again. What follows is everything that was tried, in order, including
a real mistake along the way — kept in because the mistake is the useful part.

**Attempt 1 — link preview.** WhatsApp unfurls a plain URL with a preview card, so the poster
was sent as a link rather than reopening the file-picker question at all. **Disproven by two
real sends, watched arrive:** the Drive `/view` page carries no `og:image` tag at all
(confirmed by fetching it with a WhatsApp-like user agent — only `og:title`, `og:type`,
`og:site_name`), so the card showed only a filename and domain. Rewriting the link to
`lh3.googleusercontent.com/d/<id>` (confirmed to return real `image/jpeg` bytes directly, no
redirect) didn't help either — a bare image URL has no HTML for WhatsApp to read metadata
from, so the card showed only the domain. Link preview genuinely cannot show this poster;
verified twice, not inferred.

**Attempt 2 — clipboard paste, first try — a false negative.** If WhatsApp Desktop accepts an
image pasted from the clipboard (the way a screenshot tool does), that reuses the exact
`SendKeys`/`Set-Clipboard` machinery already trusted for text — no file picker. Two clipboard
formats were tried (`CF_DIB` via `Clipboard.SetImage`, `CF_HDROP` via
`Clipboard.SetFileDropList`), tested with a sentinel placed in the composer beforehand: paste
the image, then check whether the sentinel text is still there. Both came back "sentinel still
there" and were declared a clean, disproven failure.

**That conclusion was wrong, and working code was deleted on the strength of it.** The
detection method was invalid: WhatsApp carries whatever text is already in the composer into
the image preview's *caption* field when an attach succeeds — so a successful attach and a
failed paste both leave composer text intact, and the sentinel test cannot tell them apart.
This was caught (by the person operating the app, not by re-auditing the code) when a real
send using the "known not to work" `CF_DIB` path was watched and produced exactly the video
proof it wasn't supposed to be capable of. Lesson stated plainly: a detection method has to be
validated against a *known-good* case before its "failure" result can be trusted — this one
never was.

**Attempt 3 — clipboard paste, retested with the only valid oracle: watch the chat.**
`CF_DIB` (`Clipboard.SetImage`) confirmed working via a real send, image visibly delivered.
`CF_HDROP` was not retested (a plausible reason it never worked: WhatsApp Desktop is a
packaged MSIX/UWP app — confirmed installed under
`C:\Program Files\WindowsApps\...WhatsAppDesktop` — sandboxed in an AppContainer, which can't
open an arbitrary file path handed to it that way). A third method (WinRT `DataPackage`, the
clipboard API a UWP surface natively consumes) was built as a fallback and never needed once
`CF_DIB` was confirmed sufficient — removed rather than kept as unexercised code.

**What ships:** the poster is a genuine attached image (`wa/desktop.js`'s
`setClipboardImage`/`pasteImage`/`pasteCaption`, `wa/sender.js`'s attach path), with the
message as its caption. The caption is verified with the same `verifyComposer` clipboard-
sentinel technique the text path uses — but that only proves the *caption* landed correctly,
not that the image itself attached; there is no valid way to check the image's presence
without watching the chat, per the mistake above, so this is stated as a real limit rather
than implied away. The brochure stays a link — it's a document to open, not an image to
preview, and link delivery for it was never in question.

## Anti-ban pacing: configurable, no hard ceiling — and now genuinely reachable

The product requirement was always "sensible defaults shown in the UI, every limit editable,
no hard ceiling." For a period this only half-held: the defaults lived in `.env`, which is
fine for local development but becomes a real problem the moment the app is packaged — a
packaged app's working directory is inside a read-only install (or absent entirely), so
`.env` is unreachable for a non-technical operator who needs to raise or lower a limit. This
is now fixed properly: pacing, the daily cap, the default country code, and the message
template all live in the SQLite `settings` table, editable from the app itself, with no
code-enforced ceiling on any of them.

**The daily cap is a hard stop, not the soft warn-only cap originally specified.** Flagged
here rather than silently changed: blocking is the safer default for protecting a sending
number, and since it's fully editable in the UI, an operator who wants to send more on a
given day can simply raise it.

**The default inter-recipient delay was reduced to 0/0ms (from 8000/20000ms) at explicit
operator request.** The observed "~2 minutes for 4-5 people" was mostly this randomised gap
stacked on top of the automation's own ~8s-per-recipient cycle (open chat, paste, verify,
send), not the automation itself. Flagged plainly rather than just changed: this removes the
app's main defence against a bot-like sending pattern (see [operations.md](operations.md)),
in favour of speed. It's a Settings-panel value, not a code constant, so it can be raised
back per-sender without a rebuild if a number gets flagged.

## No login/auth gate; bound to 127.0.0.1 only

An `APP_PASSWORD` auth gate existed early on, built for a scenario where the app might be
exposed over the internet. That deployment path was researched and ruled out as impossible
for this app's kind of GUI automation (see the "Postgres → SQLite" section above — it can
only run on the real desktop it's automating). In a fully offline, single-operator local
app, an auth gate is pure dead weight, and it was removed along with binding the server
explicitly to `127.0.0.1` rather than all network interfaces — this app has no reason to be
reachable from the local network, let alone the internet.

## Unsigned installer

Code-signing certificates cost real, recurring money for a small internal tool. The chosen
tradeoff: ship unsigned, and document the one-time "Windows protected your PC → More info →
Run anyway" click an operator needs to make on first install (see
[user-guide.md](user-guide.md)) rather than pay an ongoing cost to suppress that prompt. The
macOS build is unsigned for the same cost reason — see the macOS port section above for what
that costs there specifically (no auto-update, plus a stricter Gatekeeper flow than Windows'
SmartScreen prompt).

## The macOS port: osascript over a native module, no auto-update, shipped unverified

Three decisions made together, all forced by the same constraint stated upfront by the
operator: **no subscriptions or money to be introduced.**

**`osascript` + System Events, not a native automation module (robotjs/nut.js).** Mirrors the
exact reasoning behind the Windows backend's PowerShell/Win32 choice and behind picking
`node:sqlite` over a native SQLite driver: spawn a helper that ships with the OS, add zero
native dependency, avoid the single most common cause of Electron packaging failure. There
was never a real alternative under this constraint — a native module would need prebuilt
binaries per macOS architecture and a compile toolchain fallback, for no capability gain over
what `osascript` already does.

**No macOS auto-update — verified as flatly impossible for free, not merely inconvenient.**
`electron-updater`'s macOS mechanism (Squirrel.Mac) hard-requires a valid Developer ID code
signature; an ad-hoc or unsigned build cannot use it at all, full stop. The only way around
that is a paid Apple Developer Program membership ($99/yr), which was explicitly ruled out.
So macOS gets a **notify-only** banner instead: `main.js` polls the GitHub Releases API
directly and offers a "Download" link to the new `.dmg`, and CI deliberately never publishes
`latest-mac.yml` — shipping an update feed that's guaranteed to fail silently would be worse
than shipping none. Windows auto-update is completely unaffected; this divergence is
platform-inherent, not a shortcut.

A second, related wall hit during research: even *distributing* a signed-enough app to launch
at all needs *some* signature on Apple Silicon (`identity: null` alone still gets "app is
damaged" on M-series Macs) — solved for free with an ad-hoc signature (`mac.identity: "-"`
in `package.json`, which tells electron-builder to sign the whole app bundle correctly,
inside-out, itself). **v1.4.0 shipped this via a hand-rolled `codesign --force --deep --sign -`
in `build/afterPack.js` instead** — `--deep` is Apple's own deprecated, sign-from-the-outside-in
flag, which can miss or mis-order the nested Frameworks/Helper app signatures electron-builder
signs correctly when it owns the whole process. Switched to `identity: "-"` in v1.4.1 and
deleted the manual script; CI now runs `codesign --verify --strict` on the packed `.app` so a
malformed signature fails loudly in CI instead of shipping.

**None of this removes the Gatekeeper dialog — nothing free does.** The exact wording an
operator sees on first launch — *"Apple cannot check it for malicious software" / "This
software needs to be updated. Contact the developer for more information."* — is the
documented signature of an **ad-hoc-signed app running on a Mac that didn't build it**; ad-hoc
signing exists so software can run on the machine that produced it, not for distribution.
The only real fix is Developer ID signing + notarization, i.e. the $99/yr this whole feature
set is built around avoiding. **`xattr -dr com.apple.quarantine` on the installed `.app` is
the documented workaround** (removes the flag Gatekeeper's check is keyed on) and is what
`docs/user-guide.md` now leads with — the alternative, System Settings → Privacy & Security →
Open Anyway, is real but was demoted to a footnote: it's specifically unreliable for
ad-hoc-signed apps (the button doesn't always appear, and expires roughly an hour after the
blocked launch attempt when it does), which is plausibly why an install got stuck on it during
testing. `build/dmg-readme.txt` puts the same instructions directly in the `.dmg` window, and
the CI-generated GitHub release notes carry them too — the goal is that the fix is visible at
the exact moment someone hits the blocked-launch dialog, not buried in a docs folder.

**Focus-stealing regression, fixed in the same v1.4.1 pass.** The v1.3.0 overlay rewrite
(`wa/overlay.js`, a cross-platform Electron `BrowserWindow` replacing the old PowerShell
WinForms window) constructed with `show: true`. On macOS, showing *any* window activates the
*whole owning app* — so the instant `wa/sender.js`'s `overlay.start()` ran (right after
`desktop.focus()` had just brought WhatsApp forward), the Blaster snapped back in front of it.
`focusable: false` never prevented this; app-level activation happens before Electron gets to
honor a window's own focusability. Confirmed on a real Mac, and structurally impossible for
the old PowerShell overlay to have caused, since it was a wholly separate process. Fixed with
`show: false` + `showInactive()` (Electron's actual "reveal without activating" API) plus
`type: "panel"` on darwin, the platform's real non-activating floating-window primitive —
this was the design intent from the original macOS-port plan and was simply dropped during
implementation.

**Shipped unverified, deliberately, with a doctor script rather than a rewrite risk.** The
macOS backend (`wa/desktop.mac.js`) was written entirely on a Windows machine — every
keystroke mapping is based on published WhatsApp for Mac shortcuts (Cmd+N for New Chat, etc.,
confirmed to exist), but no timing constant or clipboard-image behavior has been run against
real WhatsApp. This mirrors exactly how the Windows backend was actually built — every
hard-won detail there (the 2500ms settle after typing digits, the sentinel oracle, the
CF_DIB discovery, the AttachThreadInput fix) came from watching real behaviour, not from
reading documentation. Waiting for Mac access before writing a line of the port would have
meant starting from zero once that access existed; instead, `scripts/mac-doctor.js` gives
that eventual session a structured, step-by-step verification pass with the current
`TIMINGS` printed for reference, turning "verify from scratch" into "tune what's already
there." The v1.3.0 release notes and this file both say plainly: **macOS is unverified.**

## Local SQLite database survives updates and "Start over"

Once the message template became user-editable, a new requirement followed directly: an
operator's saved message must never silently change — not on "Start over" (which only clears
*campaign* history for one sender, never settings), not across an app restart, and not when
an update installs. This is enforced by **seeding** the template into the database on first
run rather than letting it fall back to a code default at read time — if it only ever fell
back, shipping a future update with different default wording would silently rewrite the
message for every operator who had never explicitly edited it. See
[architecture.md](architecture.md) for the mechanics (`app.setName()` pinning the database
path, `seedTemplateIfMissing()`, additive-only schema migrations).

**One deliberate exception, added with the local-poster-upload feature:** "Start over" now
*also* deletes an uploaded poster image (file + the `posterUploadFilename` setting), even
though every other setting — template, name fallback, poster/brochure **links** — stays
exactly as sticky as described above. Reasoning, confirmed with the operator before
building it: a locally uploaded file is closer to "this run's" state than a durable
preference like a Drive link (which is just text, costs nothing to leave sitting in a
field) — an operator who's done with an event and clicks the one button that's supposed to
reset everything shouldn't have to separately remember to remove an old poster image too.

## Locally-uploaded poster image, as an alternative to a Drive link

The Drive-link poster flow (get the file into Drive, share it "Anyone with the link", copy
the link) is real friction for a non-technical operator who already has the image file
sitting on their computer. Added a second, mutually-exclusive source: upload the image
directly through the browser.

**Mutually exclusive by design, not just convention.** Uploading clears `posterLink`
server-side in the same request that sets `posterUploadFilename` (`server.js`'s
`POST /api/settings/poster-upload`), not only in the UI — so there's no state where both are
set and some runtime rule has to decide which one "really" applies. `wa/sender.js`'s
`effectivePoster()` still has a local-wins tiebreaker as a defensive fallback, but the normal
path never reaches it.

**Single-slot storage, not a library.** `data/local-poster/` only ever holds one file
(`wa/attachments.js`'s `saveLocalPoster()` deletes whatever was there before writing the
new one) — there's no gallery, no history, no per-campaign versioning. This matches the
feature's actual shape: one event, one poster, replace it when it changes. Keeping it
single-slot means there's nothing to garbage-collect and no orphaned-file accumulation to
worry about.

**Reused validation, not reinvented.** `saveLocalPoster()` checks the upload against the same
`MAX_BYTES` (WhatsApp's real 16MB limit) and `EXT_BY_MIME` (jpeg/png/gif/webp) constants
`downloadDriveFile()` already enforces for a Drive-sourced poster — a local upload can't
silently exceed a limit the link path already respects.
