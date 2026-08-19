const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { normaliseLineEndings, similarity, VERIFY_SIMILARITY_THRESHOLD } = require("./verify");

// Drives WhatsApp for Mac (the native Catalyst app) via System Events
// keystroke automation, the same "spawn a helper that ships with the OS, add
// no native dependency" principle as wa/desktop.win.js. `osascript` replaces
// PowerShell; System Events replaces SendKeys + Win32.
//
// UNVERIFIED: written on a Windows machine with no Mac to test against.
// Every TIMINGS value below is a starting guess seeded from the Windows
// backend's tuned constants, not a measurement. Run `npm run mac:doctor` on
// a real Mac before trusting this against a real chat — see that script for
// the tuning loop this file is meant to be corrected from.
//
// Unlike Windows, macOS text pipes (pbcopy/pbpaste) are UTF-8, so the
// base64/UTF-16LE clipboard smuggling that runPowerShellUnicode existed for
// simply doesn't apply here — text goes through pbcopy/pbpaste directly.

// WhatsApp for Mac's bundle identifier. `npm run mac:doctor` prints the
// real value from the installed app (`id of app "WhatsApp"`) in case a
// future WhatsApp release changes it.
const WHATSAPP_BUNDLE_ID = "net.whatsapp.WhatsApp";
// Must stay in sync with package.json's build.appId — nothing enforces this
// automatically. Used only by the last-resort hide path in activateWhatsApp
// (see PLAIN_ACTIVATION_ATTEMPTS below) to identify this app's own process.
const BLASTER_BUNDLE_ID = "org.whatsappblaster.app";

// Starting points only — see the file-level note above. Named here, not
// inlined, so `mac:doctor` output can be pasted straight over this block.
const TIMINGS = {
  afterActivate: 400, // before checking frontmost after `activate`
  afterNewChat: 900, // after Cmd+N, before locating/clicking the search field
  afterSearchFieldFocus: 200, // after focusing/clicking the search field, before typing digits
  afterDigits: 2500, // after typing digits, before Enter (search settle)
  afterChatOpen: 1500, // after Enter selects the chat
  afterSelectAll: 150,
  afterDelete: 200,
  afterClipboardSet: 300,
  afterPaste: 500,
  afterImagePaste: 1500,
  afterVerifySelectAll: 200,
  afterVerifyCopy: 400,
  afterRightArrow: 200,
  afterSend: 800,
  afterEscape: 200,
};

const OSA_TIMEOUT_MS = 20000;

function runOsascript(script, timeoutMs = OSA_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // Script goes over stdin (`osascript -`), not -e argv — sidesteps shell
    // and AppleScript-literal escaping entirely for anything long or
    // multi-line, mirroring why desktop.win.js buffers PowerShell script
    // text rather than passing it as separate -Command tokens.
    const child = spawn("osascript", ["-"], {});
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`osascript timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) return reject(new Error(stderr || `osascript exited ${code}`));
      resolve(stdout);
    });
    child.stdin.end(script, "utf8");
  });
}

function runCommand(command, args, timeoutMs = OSA_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {});
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        return reject(new Error(stderr || `${command} exited ${code}`));
      }
      resolve();
    });
  });
}

// pbcopy/pbpaste need no Accessibility permission (unlike keystroke) — only
// reading/writing the pasteboard. Used for both plain text and the sentinel,
// so no user text is ever embedded as an AppleScript string literal.
function pbcopy(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy", []);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))));
    child.stdin.end(text ?? "", "utf8");
  });
}

function pbpaste() {
  return new Promise((resolve, reject) => {
    const child = spawn("pbpaste", []);
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`pbpaste exited ${code}`));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

// Escapes a string for embedding inside a double-quoted AppleScript literal
// — used only for the POSIX file path in setClipboardImage, never for
// message text (which always goes through pbcopy instead).
function asQuote(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function isRunning() {
  // Top-level `application id ... is running` needs no System Events call
  // and no Accessibility permission — matches isRunning's cheap-check role
  // on Windows (a plain Get-Process, no focus assertions).
  const out = await runOsascript(`application id "${WHATSAPP_BUNDLE_ID}" is running`).catch(() => "false");
  return out.trim() === "true";
}

async function frontmostApp() {
  const out = await runOsascript(`
tell application "System Events"
  set p to first application process whose frontmost is true
  set appName to name of p
  set bundleId to ""
  try
    set bundleId to bundle identifier of p
  end try
  return bundleId & "\t" & appName
end tell
`).catch(() => "");
  const [bundleId = "", name = ""] = out.split("\t");
  return { bundleId: bundleId.trim(), name: name.trim() };
}

// Foreground check by BUNDLE IDENTIFIER, never by process/window name — the
// same anti-spoofing rule as the Windows PID comparison (a browser tab
// titled "WhatsApp" must not count as WhatsApp being focused). Reading
// `frontmost`/`bundle identifier` via System Events does not require
// Accessibility permission; only `keystroke` does.
async function isForegroundWhatsApp() {
  const { bundleId } = await frontmostApp();
  return bundleId === WHATSAPP_BUNDLE_ID;
}

// hideBlaster is a LAST-RESORT-only escape hatch, not the default path — see
// focus() below for when it actually fires. Hiding the Blaster also hides
// the always-on-top progress overlay and the Abort button (wa/overlay.js),
// since they belong to the same application; that's an acceptable one-time
// cost to rescue a run that's genuinely stuck, but not something to pay on
// every activation. With wa/overlay.js's showInactive()/type:"panel" fix,
// the overlay itself no longer steals focus back — this path exists for the
// rarer case where the operator's own click, or some other app, is what's
// holding the foreground.
async function activateWhatsApp(hideBlaster) {
  if (hideBlaster) {
    await runOsascript(`
tell application "System Events"
  repeat with p in (application processes whose bundle identifier is "${BLASTER_BUNDLE_ID}")
    try
      set visible of p to false
    end try
  end repeat
end tell
`).catch(() => "");
  }

  // Try both routes: AppleScript activation is the normal path, while
  // `open -b` is a useful fallback when LaunchServices knows the bundle but
  // AppleScript activation loses to the current app.
  await runOsascript(`tell application id "${WHATSAPP_BUNDLE_ID}" to activate`).catch(() => {});
  await runCommand("open", ["-b", WHATSAPP_BUNDLE_ID]).catch(() => {});
}

// Brings WhatsApp to the foreground. `activate` on macOS has none of
// Windows' SetForegroundWindow-refused-by-UAC problem — there is no
// foreground lock to fight, so the whole AttachThreadInput mechanism from
// desktop.win.js has no macOS equivalent and simply isn't needed. Still
// retries + verifies, matching the "never proceed to type on a guess" rule.
//
// The first 3 attempts are plain activation. Only if those all fail does
// attempt 4+ resort to hiding the Blaster app (see activateWhatsApp) — a
// last resort, not the default, because it costs the progress overlay and
// Abort button for as long as it's in effect.
const PLAIN_ACTIVATION_ATTEMPTS = 3;
const TOTAL_ACTIVATION_ATTEMPTS = 6;

async function focus() {
  const running = await isRunning();
  if (!running) throw new Error("WhatsApp is not running");

  let lastFrontmost = null;
  for (let i = 0; i < TOTAL_ACTIVATION_ATTEMPTS; i++) {
    await activateWhatsApp(i >= PLAIN_ACTIVATION_ATTEMPTS);
    await sleep(TIMINGS.afterActivate);
    lastFrontmost = await frontmostApp();
    if (lastFrontmost.bundleId === WHATSAPP_BUNDLE_ID) return;
    await sleep(TIMINGS.afterActivate);
  }

  const seen = lastFrontmost
    ? `${lastFrontmost.name || "unknown app"} (${lastFrontmost.bundleId || "no bundle id"})`
    : "unknown app";
  const hint =
    lastFrontmost?.bundleId === BLASTER_BUNDLE_ID
      ? " — WhatsApp Blaster stayed frontmost; hide it or grant Accessibility permission, then retry"
      : "";
  throw new Error(`WhatsApp did not come to the foreground; saw ${seen}${hint}`);
}

async function ensureForeground() {
  if (await isForegroundWhatsApp()) return;
  await focus();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Runs a System Events keystroke script. Callers pass AppleScript
// `keystroke`/`key code` lines only — this wraps them in the
// `tell application "System Events"` block every caller needs, and is the
// one place that touches Accessibility-gated commands.
function keystrokeScript(lines) {
  return `tell application "System Events"\n${lines}\nend tell`;
}

// Opens a chat by number: Cmd+N (New Chat), CLICK the search field to focus
// it, type the digits, Return selects the first search result — the direct
// analogue of Ctrl+N on Windows, plus one extra step Windows doesn't need.
//
// CONFIRMED ON A REAL MAC: unlike Windows (where Ctrl+N auto-focuses the
// composer's search field), WhatsApp for Mac's New Chat panel does NOT put
// keyboard focus in its search field just because the panel opened — typed
// digits landed nowhere, search field still showing its placeholder text.
// The fix is not a hardcoded x/y click position (fragile — breaks across
// window sizes/positions and any future WhatsApp UI change) but a position
// computed LIVE from the accessibility tree: System Events' `click` command
// locates and clicks a UI element wherever it actually is, the same
// "ask the OS, don't assume" principle this file already uses for identity
// checks (bundle ID, never window title). `entire contents` flattens the
// whole element tree so the field is found regardless of how deeply it's
// nested inside groups/sheets; `set focused ... to true` is tried first
// since it's more reliable than a simulated click when supported (works
// even mid-animation); `window 2` is a cheap fallback in case the panel
// renders as a second window rather than a sheet on the main one. Every
// step here is wrapped in `try` and never throws — if the field can't be
// found, the existing blind-keystroke flow below still runs regardless,
// matching this file's "a failed UI-scripting probe must never block a
// send" rule elsewhere (frontmostApp, isForegroundWhatsApp).
//
// Same trade-off as Windows otherwise: there is no way to confirm WHICH
// contact this opened, only whether the resulting composer accepts a paste
// (verifyComposer, below).
async function openChatByNumber(digits) {
  await ensureForeground();
  await runOsascript(
    keystrokeScript(`
  keystroke "n" using command down
  delay ${TIMINGS.afterNewChat / 1000}
  -- Whole block wrapped in one outer try: if ANYTHING here throws (a
  -- window that doesn't exist, an unsupported property, a timing race),
  -- the digit-typing/Enter sequence below must still run — a failed
  -- click-to-focus attempt must degrade to the old blind-keystroke
  -- behaviour, never abort the whole function.
  try
    tell (first process whose bundle identifier is "${WHATSAPP_BUNDLE_ID}")
      set candidateWindows to {}
      try
        set end of candidateWindows to window 1
      end try
      try
        set end of candidateWindows to window 2
      end try
      set targetField to missing value
      repeat with w in candidateWindows
        if targetField is missing value then
          try
            set allEls to entire contents of w
            repeat with el in allEls
              try
                if class of el is text field then
                  set targetField to el
                  exit repeat
                end if
              end try
            end repeat
          end try
        end if
      end repeat
      if targetField is not missing value then
        try
          set focused of targetField to true
        end try
        try
          click targetField
        end try
      end if
    end tell
  end try
  delay ${TIMINGS.afterSearchFieldFocus / 1000}
  keystroke "${asQuote(digits)}"
  delay ${TIMINGS.afterDigits / 1000}
  key code 36
  delay ${TIMINGS.afterChatOpen / 1000}
`)
  );
}

// Select-all + Delete FIRST, before pasting — same reason as Windows: a
// verifyComposer-failed retry must replace the composer's contents, not
// paste on top of them.
async function pasteIntoComposer(text) {
  await ensureForeground();
  await pbcopy(text);
  await runOsascript(
    keystrokeScript(`
  keystroke "a" using command down
  delay ${TIMINGS.afterSelectAll / 1000}
  key code 51
  delay ${TIMINGS.afterDelete / 1000}
  delay ${TIMINGS.afterClipboardSet / 1000}
  keystroke "v" using command down
  delay ${TIMINGS.afterPaste / 1000}
`)
  );
}

function tempPngPath(sourcePath) {
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9_-]/g, "_") || "poster";
  return path.join(os.tmpdir(), `whatsapp-blaster-${process.pid}-${Date.now()}-${base}.png`);
}

async function convertImageToPng(imagePath) {
  const pngPath = tempPngPath(imagePath);
  await runCommand("sips", ["-s", "format", "png", imagePath, "--out", pngPath]);
  return pngPath;
}

// Poster image attach via the pasteboard. The selected source can be a Drive
// download or local UI upload, and may be JPEG/PNG/GIF/WebP; convert at the
// macOS boundary with `sips` so the AppleScript pasteboard write always gets a
// real PNG file rather than assuming one particular original format.
async function setClipboardImage(imagePath) {
  const sourcePath = String(imagePath);
  if (!fs.existsSync(sourcePath)) throw new Error(`poster image not found: ${sourcePath}`);

  let pngPath = null;
  try {
    pngPath = await convertImageToPng(sourcePath);
    const posixPath = asQuote(pngPath);
    await runOsascript(`set the clipboard to (read (POSIX file "${posixPath}") as «class PNGf»)`);
  } finally {
    if (pngPath) {
      try {
        fs.unlinkSync(pngPath);
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

// Bare Cmd+V — deliberately no select-all/delete first, same non-destructive
// rule as Windows' pasteImage: against an image-preview state, selecting
// everything could delete the attachment instead of preparing an empty
// field.
async function pasteImage() {
  await ensureForeground();
  await runOsascript(
    keystrokeScript(`
  keystroke "v" using command down
  delay ${TIMINGS.afterImagePaste / 1000}
`)
  );
}

async function pasteCaption(text) {
  await ensureForeground();
  await pbcopy(text);
  await runOsascript(
    keystrokeScript(`
  delay ${TIMINGS.afterClipboardSet / 1000}
  keystroke "v" using command down
  delay ${TIMINGS.afterPaste / 1000}
`)
  );
}

// Escape — same as Windows' discardAttachment, and just as unverified
// whether it actually dismisses an image-preview state on WhatsApp Mac.
// wa/sender.js already treats this as unreliable enough to skip the image
// step entirely during a dry-run (see discardAttachment's Windows
// counterpart) — that same caution applies here without any code change.
async function discardAttachment() {
  await runOsascript(
    keystrokeScript(`
  key code 53
  delay ${TIMINGS.afterEscape / 1000}
  key code 53
`)
  ).catch(() => {});
}

// Proves the pasted text landed in a real composer before Return is ever
// pressed — identical oracle design to Windows (wa/verify.js), only the
// keystrokes to select-all/copy differ.
async function verifyComposer(text) {
  const sentinel = `WAB-VERIFY-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await pbcopy(sentinel);
  await runOsascript(
    keystrokeScript(`
  keystroke "a" using command down
  delay ${TIMINGS.afterVerifySelectAll / 1000}
  keystroke "c" using command down
  delay ${TIMINGS.afterVerifyCopy / 1000}
`)
  );
  const got = await pbpaste().catch(() => "");
  const score = similarity(normaliseLineEndings(text), normaliseLineEndings(got));
  return { ok: score >= VERIFY_SIMILARITY_THRESHOLD, got, score };
}

// Deselects then sends. Same honest limit as Windows: post-send delivery
// cannot be verified (WhatsApp for Mac's composer, like Windows, exposes
// nothing else to check against) — every submit is reported 'submitted',
// never confirmed 'sent'. The composer content IS verified, just before
// Return (verifyComposer, above).
async function pressEnterToSend() {
  await ensureForeground();
  await runOsascript(
    keystrokeScript(`
  key code 124
  delay ${TIMINGS.afterRightArrow / 1000}
  key code 36
  delay ${TIMINGS.afterSend / 1000}
`)
  );
}

async function resetToCleanState() {
  await runOsascript(
    keystrokeScript(`
  key code 53
  delay ${TIMINGS.afterEscape / 1000}
  key code 53
`)
  ).catch(() => {});
}

async function closeChat() {
  await runOsascript(keystrokeScript(`key code 53`)).catch(() => {});
}

async function clearComposer() {
  await ensureForeground();
  await runOsascript(
    keystrokeScript(`
  keystroke "a" using command down
  delay ${TIMINGS.afterSelectAll / 1000}
  key code 51
`)
  ).catch(() => {});
}

// Save/restore the operator's clipboard around a whole run, same as
// Windows. Returns null (not "") on failure so setClipboard can tell
// "couldn't read it" from "it was genuinely empty" and refuse to overwrite
// the operator's real clipboard with emptiness.
async function getClipboard() {
  try {
    return await pbpaste();
  } catch {
    return null;
  }
}

async function setClipboard(text) {
  if (text === null || text === undefined) return;
  await pbcopy(text).catch(() => {});
}

module.exports = {
  isRunning,
  focus,
  openChatByNumber,
  pasteIntoComposer,
  verifyComposer,
  pressEnterToSend,
  resetToCleanState,
  closeChat,
  clearComposer,
  getClipboard,
  setClipboard,
  setClipboardImage,
  pasteImage,
  pasteCaption,
  discardAttachment,
  WHATSAPP_BUNDLE_ID,
  BLASTER_BUNDLE_ID,
  TIMINGS,
};
