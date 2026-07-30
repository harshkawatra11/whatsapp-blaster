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
copy artifact, diagnosed by dumping a real capture: a template ending `- Team RYS` came back
as `* Team RYS`, one character different in 221. Exact-string comparison made every real send
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

## The poster image was dropped

The original requirements plan specified "templated text as caption + poster image inline,"
with the brochure/form as auto-previewing links in the text. This was dropped during the
Baileys → whatsapp-web.js → Puppeteer → WhatsApp Desktop migrations, initially without an
explicit decision to do so — attaching an image via keyboard automation would mean scripting
the WhatsApp Desktop file picker and its preview/send dialog, a materially more fragile flow
than pasting text, and it was deprioritised along the way. When this drift was later
audited against the original plan, **text-only was explicitly confirmed as the actual
requirement** and formally closed — the poster-image path is gone deliberately, not by
accident.

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
[user-guide.md](user-guide.md)) rather than pay an ongoing cost to suppress that prompt.

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
