const { spawn } = require("child_process");

// Drives the WhatsApp Desktop Windows app via keyboard automation. No new
// dependency: everything needed (window focus, SendKeys, clipboard) ships
// with Windows and is reached through PowerShell.
//
// This exists because WhatsApp Desktop publishes NOTHING to Windows UI
// Automation — verified directly: a maximised, focused WhatsApp.Root window
// has exactly 8 descendant elements (title bar chrome only). No search box,
// no chat list, no composer, no message bubbles. So there is nothing to find
// or click, and nothing to read back to confirm a send. Navigation is
// therefore blind keystrokes, and delivery cannot be verified — every send
// is reported as 'submitted', not 'sent', because that is the honest limit
// of what this mechanism can know.
//
// The one signal that IS readable without OCR is the foreground window
// title, via Win32 GetForegroundWindow. Every script below asserts WhatsApp
// is focused before typing anything, so a stray click elsewhere fails that
// recipient instead of pasting the invite into some other window.

// The Store/WinUI build's actual process name is "WhatsApp.Root", not
// "WhatsApp" — verified via Get-Process. Matched with -like so either naming
// (older builds shipped plain "WhatsApp") still resolves.
const WHATSAPP_PROCESS_FILTER = "*WhatsApp*";

// A PowerShell child blocked on a contended clipboard (Office, RDP, and
// clipboard managers all take that lock routinely) previously hung this
// promise forever — the send loop never advanced, the overlay never
// stopped, and the NDJSON response never closed. 20s is generously above
// every script's normal runtime (a few seconds of Start-Sleep at most) but
// bounds the worst case.
const PS_TIMEOUT_MS = 20000;

function runPowerShell(script, timeoutMs = PS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`powershell timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Buffers are collected whole and decoded once at the end, not
    // string-concatenated chunk-by-chunk — `stdout += d` invokes an
    // implicit per-chunk toString() that can split a multi-byte character
    // across a chunk boundary and mangle it.
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
      if (code !== 0) return reject(new Error(stderr || `powershell exited ${code}`));
      resolve(stdout);
    });
  });
}

// For scripts whose final Write-Output is base64(UTF-16LE) rather than plain
// text. Necessary because PowerShell's stdout is written through the console
// codepage (not UTF-8), so any non-ASCII character in returned text — an
// em-dash, a curly quote, an emoji, an accent — comes back corrupted
// otherwise. Reproduced directly: "café" round-tripped as "caf�" over plain
// stdout, and came back correct once routed through this path. This matters
// specifically because the message template became user-editable, and a
// plain hardcoded ASCII template was masking the bug.
async function runPowerShellUnicode(script) {
  const b64 = await runPowerShell(script);
  if (!b64) return "";
  return Buffer.from(b64, "base64").toString("utf16le");
}

// Shared PowerShell preamble: Win32 focus/foreground helpers plus the two
// .NET assemblies used throughout (SendKeys, Clipboard).
//
// Foreground checks are done by OWNING PROCESS, not window title text. A
// title regex like /whatsapp/i is a real trap here: a Chrome tab titled
// "(11) WhatsApp - Google Chrome" matches it too, which would let keystrokes
// fire into the browser while the app believes WhatsApp Desktop is focused.
// GetWindowThreadProcessId + a process-id comparison cannot be fooled by tab
// titles.
const PS_PREAMBLE = `
Add-Type -AssemblyName System.Windows.Forms
$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
// GetCurrentThreadId lives in kernel32, NOT user32. Importing it from the
// wrong DLL makes the P/Invoke fail, which silently left the thread id null
// and AttachThreadInput a no-op — so focus only ever worked when Windows
// happened to permit SetForegroundWindow outright, and failed hard against
// an app like Chrome that holds the foreground lock.
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
'@
Add-Type -MemberDefinition $sig -Name Win32 -Namespace RYS

function Get-ForegroundTitle {
  $h = [RYS.Win32]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 256
  [RYS.Win32]::GetWindowText($h, $sb, 256) | Out-Null
  return $sb.ToString()
}

function Get-WhatsAppProcessIds {
  return (Get-Process | Where-Object { $_.Name -like "${WHATSAPP_PROCESS_FILTER}" }).Id
}

function Test-ForegroundIsWhatsApp {
  $fgWnd = [RYS.Win32]::GetForegroundWindow()
  $ownerPid = 0
  [RYS.Win32]::GetWindowThreadProcessId($fgWnd, [ref]$ownerPid) | Out-Null
  $waIds = @(Get-WhatsAppProcessIds)
  return ($waIds -contains $ownerPid)
}

# SetForegroundWindow is refused by Windows (since Vista/UAC) when the caller
# isn't already the foreground process — which is every time this app tries
# to activate WhatsApp from a browser click. AttachThreadInput bonds our
# thread's input state to the current foreground thread's, which makes
# Windows treat the activation as coming from an already-related process and
# lets it through.
function Set-ForegroundReliable([IntPtr]$hwnd) {
  $fgWnd = [RYS.Win32]::GetForegroundWindow()
  $dummy = 0
  $fgThread = [RYS.Win32]::GetWindowThreadProcessId($fgWnd, [ref]$dummy)
  $ourThread = [RYS.Win32]::GetCurrentThreadId()
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $ourThread) {
    $attached = [RYS.Win32]::AttachThreadInput($ourThread, $fgThread, $true)
  }
  [RYS.Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE — un-minimise first
  Start-Sleep -Milliseconds 150
  [RYS.Win32]::ShowWindow($hwnd, 3) | Out-Null   # SW_MAXIMIZE
  [RYS.Win32]::BringWindowToTop($hwnd) | Out-Null
  [RYS.Win32]::SetForegroundWindow($hwnd) | Out-Null
  if ($attached) { [RYS.Win32]::AttachThreadInput($ourThread, $fgThread, $false) | Out-Null }
}
`;

async function isRunning() {
  const out = await runPowerShell(
    `Get-Process | Where-Object { $_.Name -like "${WHATSAPP_PROCESS_FILTER}" } | Select-Object -First 1 -ExpandProperty Id`
  ).catch(() => "");
  return out.trim().length > 0;
}

// Brings WhatsApp Desktop to the foreground, maximised. Retries the
// AttachThreadInput activation a few times (a single attempt can lose a race
// with whatever currently owns focus), then verifies by OWNING PROCESS
// before returning. Throws if the process isn't running or focus was never
// actually won — callers must not proceed to type on a guess.
async function focus() {
  const script = `${PS_PREAMBLE}
$p = Get-Process | Where-Object { $_.Name -like "${WHATSAPP_PROCESS_FILTER}" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "NO_WINDOW"; exit }
$ok = $false
for ($i = 0; $i -lt 3; $i++) {
  Set-ForegroundReliable $p.MainWindowHandle
  Start-Sleep -Milliseconds 400
  if (Test-ForegroundIsWhatsApp) { $ok = $true; break }
  Start-Sleep -Milliseconds 400
}
if (-not $ok) { Write-Output ("FAILED:" + (Get-ForegroundTitle)); exit }
Write-Output (Get-ForegroundTitle)
`;
  const result = await runPowerShell(script);
  if (result === "NO_WINDOW" || result.startsWith("FAILED:")) {
    const seen = result.startsWith("FAILED:") ? result.slice(7) : result;
    throw new Error(`WhatsApp Desktop did not come to the foreground (saw "${seen}")`);
  }
  return result;
}

// Cheap check first; only pays for the full AttachThreadInput re-activation
// (via focus()) when the foreground has actually drifted away — e.g. the
// operator clicked back into Chrome between sends. This repairs a transient
// focus loss instead of just failing the recipient on it.
async function ensureForeground() {
  const ok = await runPowerShell(`${PS_PREAMBLE}\nWrite-Output (Test-ForegroundIsWhatsApp)`);
  if (ok.trim() === "True") return;
  await focus();
}

function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

// Escapes a string for System.Windows.Forms.SendKeys, where + ^ % ~ ( ) { }
// [ ] are all special. Phone digits never contain these, but this keeps the
// helper correct if it's ever used for anything else.
function sendKeysEscape(s) {
  return String(s).replace(/([+^%~(){}[\]])/g, "{$1}");
}

// Opens a chat by number: New Chat, type the digits, Enter selects the
// first search result. This is the ONE path used for every send — the
// alternative (the whatsapp:// deep link, which passed the number to
// WhatsApp directly with no search step) was removed on request: it visibly
// resolved through WhatsApp's own contact-matching before landing on a
// chat, which is exactly the "searching through my contacts" behaviour that
// was not wanted. Ctrl+N is simple and deterministic: the digits typed are
// exactly what gets searched, every time.
//
// Trade-off, stated plainly: there is no way to confirm WHICH contact this
// actually opened — WhatsApp Desktop exposes nothing to check that against,
// only whether the resulting composer accepted a paste (verifyComposer,
// below). That was already true of this function when it was the fallback;
// it now carries the whole flow instead of a rare edge case.
async function openChatByNumber(digits) {
  await ensureForeground();
  const keys = sendKeysEscape(digits);
  const script = `${PS_PREAMBLE}
[System.Windows.Forms.SendKeys]::SendWait("^n")
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait('${psQuote(keys)}')
Start-Sleep -Milliseconds 2500
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 1500
`;
  await runPowerShell(script);
}

// Pastes `text` into whatever currently holds focus, WITHOUT sending.
// Split out from the old paste+Enter combo specifically so the composer can
// be verified in between — that ordering is the entire point of this file.
//
// Select-all + Delete FIRST, before pasting. Without this, a retry (the
// verifyComposer-failed fallback in sender.js) pastes on top of whatever is
// already in the composer instead of replacing it — the "message saved
// twice" bug: a false-negative verify reopens the same chat and pastes the
// same text again, doubling it in the draft.
async function pasteIntoComposer(text) {
  await ensureForeground();
  const b64 = Buffer.from(text, "utf16le").toString("base64");
  const script = `${PS_PREAMBLE}
$bytes = [Convert]::FromBase64String('${b64}')
$msg = [System.Text.Encoding]::Unicode.GetString($bytes)
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("{DEL}")
Start-Sleep -Milliseconds 200
Set-Clipboard -Value $msg
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 500
`;
  await runPowerShell(script);
}

// Windows text controls round-trip line breaks as CRLF regardless of what
// was pasted in. The template is authored with bare LF, so an exact string
// compare between the pasted text and what gets copied back ALWAYS fails on
// any multi-line message — this is what silently broke every real send
// while passing the single-line test that first validated this function.
function normaliseLineEndings(s) {
  return String(s).replace(/\r\n?/g, "\n").trim();
}

// WhatsApp's composer applies its own rich-text autoformatting as text lands
// in it — e.g. "- " at the start of a line becomes a bullet "* ". That is a
// REAL, intentional change to the composer's content, not a copy/paste
// artifact, so exact equality is the wrong bar even after line-ending
// normalisation (diagnosed by dumping a real capture: a template ending
// "- Team RYS" came back as "* Team RYS", one character different in 221).
// A same-length, mostly-matching string is exactly what a legitimate paste
// looks like; empty, truncated, or unrelated content is what a genuine
// failure looks like. Position-wise similarity on same-length text — or
// automatic failure on a large length gap — distinguishes the two without
// hand-listing every markdown-ish pattern WhatsApp might rewrite.
function similarity(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  let matches = minLen - maxLen; // length gap counts against the score (0 when lengths are equal)
  for (let i = 0; i < minLen; i++) if (a[i] === b[i]) matches++;
  return Math.max(0, matches) / maxLen;
}

const VERIFY_SIMILARITY_THRESHOLD = 0.95;

// Proves the pasted text landed in a REAL composer before Enter is ever
// pressed. WhatsApp Desktop exposes nothing to UI Automation, but the
// clipboard is readable, so: overwrite it with a one-time sentinel, select
// all + copy from whatever holds focus, then check what came back.
//   - got the sentinel back  -> the copy produced nothing new; no editable
//                               field is focused (or it's empty) -> FAIL
//   - got near-`text` back   -> a real text field holds our message -> PASS
//   - got anything else      -> unexpected selection (e.g. the chat list) -> FAIL
// The sentinel is load-bearing: without it, a failed copy would leave
// `text` still on the clipboard from pasteIntoComposer and read as a false
// pass.
//
// Returns { ok, got, score } rather than a bare boolean — surfacing what was
// actually seen turns the next verification failure into a diagnosable
// error message instead of another silent opaque loop.
async function verifyComposer(text) {
  const sentinel = `RYS-VERIFY-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const script = `${PS_PREAMBLE}
Set-Clipboard -Value '${psQuote(sentinel)}'
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("^c")
Start-Sleep -Milliseconds 400
$captured = try { Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $null }
if ($null -eq $captured) { $captured = "" }
[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($captured))
`;
  const got = await runPowerShellUnicode(script);
  const score = similarity(normaliseLineEndings(text), normaliseLineEndings(got));
  return { ok: score >= VERIFY_SIMILARITY_THRESHOLD, got, score };
}

// Deselects (so Enter can't fire an accelerator on a selection) and sends.
//
// This deliberately does NOT re-check the composer afterwards. An earlier
// version tried to confirm the send by re-running the same sentinel
// select-all-and-copy trick post-Enter, expecting an empty composer back.
// Measured directly: after Enter, the foreground window's OWNING PROCESS ID
// changes on every single check (WhatsApp Desktop is WebView2-based, and
// sending visibly shifts focus to a different internal surface — most
// likely the message transcript), and Get-Clipboard came back null — not
// empty string, null — meaning Ctrl+C was copying something whose clipboard
// representation isn't plain text at all. That held true at every
// checkpoint out to 8+ seconds, so it isn't a slow-clearing timing issue;
// it's a different UI region that this technique cannot safely read. It was
// producing false FAILURE reports on sends that had actually gone through.
// Post-send delivery cannot be verified here — WhatsApp Desktop exposes
// nothing else to check it with, and OCR was explicitly ruled out — so
// every submit is reported as 'submitted', not confirmed 'sent'. The
// composer state IS still verified, just before Enter (verifyComposer,
// above), which is the check that's actually reliable.
async function pressEnterToSend() {
  await ensureForeground();
  const script = `${PS_PREAMBLE}
[System.Windows.Forms.SendKeys]::SendWait("{RIGHT}")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 800
`;
  await runPowerShell(script);
}

// Escape twice before each recipient so a leftover panel, unsaved-selection
// state, or stray dialog from the previous iteration can't swallow the next
// set of keystrokes.
async function resetToCleanState() {
  await runPowerShell(
    `${PS_PREAMBLE}\n[System.Windows.Forms.SendKeys]::SendWait("{ESC}"); Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait("{ESC}")`
  ).catch(() => {});
}

// Save/restore the operator's clipboard around a whole run — verifyComposer
// and pasteIntoComposer both overwrite it repeatedly in the meantime.
// Returns null (not "") on failure, distinctly from a genuinely empty
// clipboard — setClipboard treats null as "don't touch it", so a transient
// PowerShell failure here can't overwrite the operator's real clipboard with
// emptiness, which is the exact harm this save/restore exists to prevent.
async function getClipboard() {
  try {
    return await runPowerShellUnicode(`
$captured = try { Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $null }
if ($null -eq $captured) { $captured = "" }
[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($captured))
`);
  } catch {
    return null;
  }
}

async function setClipboard(text) {
  if (text === null || text === undefined) return;
  const b64 = Buffer.from(text, "utf16le").toString("base64");
  await runPowerShell(
    `$bytes = [Convert]::FromBase64String('${b64}'); Set-Clipboard -Value ([System.Text.Encoding]::Unicode.GetString($bytes))`
  ).catch(() => {});
}

async function closeChat() {
  await runPowerShell(`${PS_PREAMBLE}\n[System.Windows.Forms.SendKeys]::SendWait("{ESC}")`).catch(() => {});
}

// Wipes whatever is in the composer without sending it. Used when
// pressEnterToSend() reports the send didn't actually go through, so a
// failed recipient doesn't leave an unsent draft sitting in that chat for
// the next run (or the next paste) to double up on.
async function clearComposer() {
  await ensureForeground();
  await runPowerShell(
    `${PS_PREAMBLE}\n[System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait("{DEL}")`
  ).catch(() => {});
}

// ensureForeground is used only internally (by focus's retry path and every
// keystroke-sending function here) — not exported, since nothing outside
// this file calls it directly.
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
};
