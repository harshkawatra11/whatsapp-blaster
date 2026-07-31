# User guide

This app sends your WhatsApp invite message to everyone in a CSV list, one at a time,
through the WhatsApp Desktop app already installed on this computer. You don't need to know
anything technical to use it — this guide covers everything from install to your first send.

## Before you install

You need **WhatsApp Desktop** (the official Windows app from the Microsoft Store) already
installed and **signed in** on this computer. This app does not log you into WhatsApp — it
types and clicks into the WhatsApp Desktop window that's already open, the same way you
would by hand, just faster and more consistently. If WhatsApp Desktop isn't running, the app
will tell you plainly rather than fail silently.

## Installing

1. Download `WhatsApp Blaster Setup.exe` from the link you were given.
2. Double-click it. Windows will very likely show a blue **"Windows protected your PC"**
   screen. This is expected — the installer isn't digitally signed (that costs money every
   year, and this is an internal tool, not something sold to the public), so Windows is
   just being cautious about a file it doesn't recognise yet.
   - Click **More info**.
   - Click **Run anyway**.
3. Follow the install wizard — the defaults are fine. It creates a shortcut on your Desktop
   and in the Start Menu, so you can find it later by typing "WhatsApp Blaster" into the
   Windows search bar.
4. Open it. The first launch may take a few seconds longer than usual.

## The four steps

### Step 1 — Connect

- The app lists WhatsApp numbers it already knows about. If this is your first time, click
  **+ Add sender number** and type in the phone number WhatsApp Desktop is signed in as on
  this PC. This isn't a login — it's just a label so the app can track how many messages
  have gone out from this number (see [operations.md](operations.md) for why that matters).
- Right below that is the **Message Template** — the exact text every recipient will
  receive. See [Editing the message](#editing-the-message) below.
- Click **Continue** once a number is selected.

### Step 2 — Upload CSV

Your file needs two columns the app can recognise:

- A **name** column — any of: `name`, `full name`, `participant`, `student`,
  `participant name`.
- A **phone** column — any of: `phone`, `mobile`, `number`, `contact`, `whatsapp`,
  `phone number`, `mobile number`.

Column names are matched case-insensitively and don't need to match exactly — "Mobile
Number" and "mobile" both work. Phone numbers can be entered as bare 10-digit Indian numbers
(`9876543210`) — the app adds the country code automatically — or already include one
(`919876543210`, `+91 98765 43210`). Rows with a phone number the app can't make sense of,
or that repeats an earlier row in the same file, are automatically marked **skipped** with a
reason — they don't stop the rest of the file from loading, and they don't get renumbered
out of the list.

**S.No. always means the line number in your own file** — row 1 of your data (not counting
the header row) is always S.No. 1, whether or not it ends up skipped. That's the number
you'll use in the next step.

### Step 3 — Select

Pick which rows actually get sent to, by S.No. range (e.g. 1 to 50) or by hand-picking rows
in the table. Rows already marked **submitted** from an earlier run are excluded
automatically — you cannot accidentally message the same person twice within one campaign.

### Step 4 — Send

Click **Send Invites**. From this point:

- **Keep the WhatsApp Desktop window visible and don't touch the mouse or keyboard** while a
  batch is running. The app is literally typing and clicking for you — anything that steals
  focus away from WhatsApp (clicking into another window, a popup notification grabbing
  focus) will make that one send fail. It'll usually recover and continue with the next
  recipient, but it's best avoided.
- A small always-on-top status bar in the corner of your screen shows live progress, since
  the main app window may be behind WhatsApp Desktop during a run.
- Sends are deliberately paced with random gaps and occasional longer pauses — this is not a
  bug, it's what keeps the sending number safe (see [operations.md](operations.md)).
- If you need to stop, click **Abort**. It finishes whatever message is currently in
  progress and then stops before starting the next one.

## What "Submitted" actually means

You'll see every result reported as **Submitted** or **Failed** — never "Delivered" or
"Read". This is intentional and honest: WhatsApp Desktop doesn't give this app any way to
confirm a message actually arrived, only that the message was typed into the right chat and
the Send action was triggered. **Submitted means sent, not confirmed received.** If you want
delivery confirmation, check WhatsApp Desktop's own chat list — the usual grey/blue tick
marks are all still there, this app just can't read them.

## Editing the message

Click into the **Message Template** box on Step 1. It's a plain text box — write the message
exactly as you want participants to receive it. To personalise it:

- Click **+ Name** to insert the recipient's name wherever your cursor is.
- Click **+ S.No.** or **+ Phone** the same way, if you want either in the message.
- The **preview** below the box always shows exactly what a real recipient would see, using
  a row from your uploaded CSV once one's loaded (or a sample name before that).
- If a row in your CSV has a blank name, the app substitutes whatever you've set as the
  fallback (defaults to "there" — "Hi there,") instead of literally sending "Hi {{name}},".
- Click **Save message** when you're happy with it. It's saved immediately and used by every
  future send — including in a future app update — until you change it again.
- **Reset to default** puts the original built-in invite text back into the box, but doesn't
  save it automatically — you still need to click Save if you want to keep that.

One thing worth knowing: WhatsApp's own composer rewrites certain formatting as you paste —
most notably, a line starting with `- ` becomes a bullet `* `. The editor warns you if it
spots this, since it's the one thing most likely to make a send get reported as failed even
though the message went through fine.

## Adding a poster image or brochure link

Below the message box is an optional **Poster & Brochure** section. Both take a Google Drive
link — the file must be shared as **"Anyone with the link can view"**, otherwise the app has
no way to reach it (no Google sign-in happens anywhere in this app).

- **Poster** — sent as a real image attachment, with your message as its caption. The app
  downloads it once before a run starts (not once per recipient), then attaches the same
  local copy to every message.
- **Brochure** — added as a plain link line under your message: `View Brochure: <link>`.
  WhatsApp has no way to hide a link behind other text, so the link itself is what recipients
  see and tap — but it's tappable either way, since WhatsApp auto-detects any bare
  `https://` link as a blue, tappable link on its own. The app shortens the raw Google Drive
  link via TinyURL before sending (once per distinct link, not per recipient) so what shows
  up is short and clean instead of a long Drive URL; if shortening fails for any reason it
  quietly falls back to the original link, so a send is never blocked by it.
  (A poster is sent as an image rather than a link because a link genuinely
  can't show one here — Google Drive's page doesn't carry the information WhatsApp needs to
  render a preview picture. See `docs/decisions.md` if you want the full story.)
- Leave either blank to skip it — the app sends plain text, exactly as before.
- If your CSV has its own `POSTER LINK` or `ATTACHMENT LINK` column, that row's own value is
  used instead of what's set here — this section is the fallback for everyone else, and the
  only place to put a poster/brochure at all if your CSV doesn't have those columns.
- Before a send starts, the app fetches the poster once and checks the brochure link, telling
  you loudly in the log if either doesn't work (a deleted file, a private share) — you don't
  have to wait for every recipient to fail individually to find out.
- A broken brochure link never stops a send — it's just a link line that may not open. A
  poster that fails to download stops **that recipient** specifically (reported failed with a
  clear reason), since sending a different message than intended would be worse than not
  sending; a broken brochure link carries no such risk, so it's treated more leniently.

## Troubleshooting

**"WhatsApp Desktop did not come to the foreground"** — WhatsApp Desktop isn't open, or
isn't signed in. Open it, make sure you're logged in, and try again.

**A run stops after a few failures in a row** — the app automatically stops after 3
consecutive failures, on the assumption something is actually wrong (WhatsApp lost focus,
got closed, a dialog is blocking it) rather than a run of bad luck. Check the WhatsApp
Desktop window, then retry the failed rows from Step 3/4 (the app tracks who's already been
sent to).

**A recipient never got the message despite showing "Submitted"** — check WhatsApp Desktop's
own chat with them directly. "Submitted" only means the app successfully typed and sent it
from this end.

**The app won't start / shows an error dialog on launch** — note the exact error message,
then try restarting your computer once (this clears any lingering PowerShell or WhatsApp
processes) before asking for help.
