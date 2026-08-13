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

// Starting points only — see the file-level note above. Named here, not
// inlined, so `mac:doctor` output can be pasted straight over this block.
const TIMINGS = {
  afterActivate: 400, // before checking frontmost after `activate`
  afterNewChat: 900, // after Cmd+N, before typing digits
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

// Foreground check by BUNDLE IDENTIFIER, never by process/window name — the
// same anti-spoofing rule as the Windows PID comparison (a browser tab
// titled "WhatsApp" must not count as WhatsApp being focused). Reading
// `frontmost`/`bundle identifier` via System Events does not require
// Accessibility permission; only `keystroke` does.
async function isForegroundWhatsApp() {
  const out = await runOsascript(`
tell application "System Events"
  set p to first application process whose frontmost is true
  return bundle identifier of p
end tell
`).catch(() => "");
  return out.trim() === WHATSAPP_BUNDLE_ID;
}

// Brings WhatsApp to the foreground. `activate` on macOS has none of
// Windows' SetForegroundWindow-refused-by-UAC problem — there is no
// foreground lock to fight, so the whole AttachThreadInput mechanism from
// desktop.win.js has no macOS equivalent and simply isn't needed. Still
// retries + verifies, matching the "never proceed to type on a guess" rule.
async function focus() {
  const running = await isRunning();
  if (!running) throw new Error("WhatsApp is not running");

  let ok = false;
  for (let i = 0; i < 3; i++) {
    await runOsascript(`tell application id "${WHATSAPP_BUNDLE_ID}" to activate`);
    await sleep(TIMINGS.afterActivate);
    if (await isForegroundWhatsApp()) {
      ok = true;
      break;
    }
    await sleep(TIMINGS.afterActivate);
  }
  if (!ok) throw new Error("WhatsApp did not come to the foreground");
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

// Opens a chat by number: Cmd+N (New Chat), type the digits, Return selects
// the first search result — the direct analogue of Ctrl+N on Windows. Same
// trade-off as Windows: there is no way to confirm WHICH contact this
// opened, only whether the resulting composer accepts a paste
// (verifyComposer, below).
async function openChatByNumber(digits) {
  await ensureForeground();
  await runOsascript(
    keystrokeScript(`
  keystroke "n" using command down
  delay ${TIMINGS.afterNewChat / 1000}
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

// Poster image attach via the pasteboard, PNG-typed. `imagePath` may be a
// JPEG (wa/attachments.js caches by source MIME type) — handing raw JPEG
// bytes to AppleScript's «class PNGf» coercion would mislabel them, so the
// caller (wa/sender.js via wa/attachments.js) is expected to have already
// produced a PNG path when this runs on macOS. UNVERIFIED — the Windows
// CF_DIB mechanism this mirrors took real trial-and-error to find; this
// osascript form is the documented approach but has not been tried against
// WhatsApp's own composer.
async function setClipboardImage(imagePath) {
  const posixPath = asQuote(String(imagePath));
  await runOsascript(`set the clipboard to (read (POSIX file "${posixPath}") as «class PNGf»)`);
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
  TIMINGS,
};
