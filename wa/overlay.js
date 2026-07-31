const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// A small always-on-top status window so a long campaign run stays visible
// while WhatsApp Desktop is maximised and focused for hours. Same "drive
// Windows via a spawned powershell.exe" approach as wa/desktop.js — no new
// dependency.
//
// The overlay must NEVER be able to take focus — doing so would break the
// exact keystrokes it's reporting on. Plain WinForms can't guarantee this:
// ShowWithoutActivation and the WS_EX_NOACTIVATE extended window style are
// only settable by overriding protected members of Form, which requires a
// real subclass (Add-Type -Language CSharp below), not a script working
// against a base Form instance. Deliberately no buttons on it either — a
// clickable control here would itself be a focus-stealing hazard, for a
// feature (Abort) that already exists in the browser.
//
// Progress is passed via a polled temp FILE, not stdin. An earlier version
// read stdin on a raw System.Threading.Thread — but a bare OS thread has no
// PowerShell runspace, so a PowerShell ScriptBlock handed to it as a
// ThreadStart can never execute; the reader silently never ran and the
// window stayed frozen on its initial text forever. A
// System.Windows.Forms.Timer ticking on the UI thread has none of that
// problem — no second thread, nothing to marshal back with Invoke.

const STATE_FILE = path.join(os.tmpdir(), "wab-overlay-state.json");

const OVERLAY_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Language CSharp -ReferencedAssemblies System.Windows.Forms,System.Drawing @"
using System;
using System.Windows.Forms;
public class NoActivateForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      const int WS_EX_NOACTIVATE = 0x08000000;
      const int WS_EX_TOOLWINDOW = 0x00000080;
      const int WS_EX_TOPMOST    = 0x00000008;
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
      return cp;
    }
  }
}
"@

$statePath = '${STATE_FILE.replace(/'/g, "''")}'

$form = New-Object NoActivateForm
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(24,24,24)
$form.Width = 360
$form.Height = 96
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 16), 16)
$form.Opacity = 0.94

$title = New-Object System.Windows.Forms.Label
$title.Text = "WhatsApp Blaster"
$title.ForeColor = [System.Drawing.Color]::FromArgb(37,211,102)
$title.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $false
$title.Size = New-Object System.Drawing.Size(340, 18)
$title.Location = New-Object System.Drawing.Point(10, 6)
$form.Controls.Add($title)

$counts = New-Object System.Windows.Forms.Label
$counts.Text = "Waiting to start..."
$counts.ForeColor = [System.Drawing.Color]::White
$counts.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$counts.AutoSize = $false
$counts.Size = New-Object System.Drawing.Size(340, 18)
$counts.Location = New-Object System.Drawing.Point(10, 28)
$form.Controls.Add($counts)

$current = New-Object System.Windows.Forms.Label
$current.Text = ""
$current.ForeColor = [System.Drawing.Color]::FromArgb(180,180,180)
$current.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$current.AutoSize = $false
$current.Size = New-Object System.Drawing.Size(340, 18)
$current.Location = New-Object System.Drawing.Point(10, 48)
$form.Controls.Add($current)

$status = New-Object System.Windows.Forms.Label
$status.Text = ""
$status.ForeColor = [System.Drawing.Color]::FromArgb(140,140,140)
$status.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$status.AutoSize = $false
$status.Size = New-Object System.Drawing.Size(340, 18)
$status.Location = New-Object System.Drawing.Point(10, 68)
$form.Controls.Add($status)

# Track the file's last-modified time so an unchanged file is a cheap no-op
# each tick rather than a re-parse. Must be $script:-scoped: a plain
# assignment inside the Add_Tick scriptblock creates a NEW variable in the
# scriptblock's own scope instead of updating this one, so the comparison
# below never saw a change and this "optimisation" silently never
# short-circuited a single tick.
$script:lastWrite = [DateTime]::MinValue

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
  if (-not (Test-Path -LiteralPath $statePath)) { return }
  $mtime = (Get-Item -LiteralPath $statePath).LastWriteTimeUtc
  if ($mtime -eq $script:lastWrite) { return }
  $script:lastWrite = $mtime
  try {
    $evt = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($evt.counts) {
      $counts.Text = "Submitted $($evt.counts.submitted)  ·  Failed $($evt.counts.unknown)  ·  Skipped $($evt.counts.skipped)  ·  Left $($evt.counts.remaining)"
    }
    if ($evt.current) { $current.Text = "-> $($evt.current)" } else { $current.Text = "" }
    if ($evt.status)  { $status.Text = $evt.status }
    if ($evt.done) {
      $status.Text = "Run finished."
      $timer.Stop()
      $form.Close()
    }
  } catch { }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
`;

let child = null;

function writeState(payload) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload));
  } catch {
    /* best-effort — a missed frame just means the next tick catches up */
  }
}

// Spawns the overlay if one isn't already running. Safe to call repeatedly —
// a second start() while one is active is a no-op, matching the one-run-
// at-a-time assumption already made by the rest of the sender.
function start() {
  if (child) return;
  writeState({ status: "Waiting to start..." }); // exists before the first tick fires
  child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", OVERLAY_SCRIPT],
    { stdio: "ignore", windowsHide: true }
  );
  child.on("exit", () => {
    child = null;
  });
  child.on("error", () => {
    child = null;
  });
}

// { counts: {submitted, unknown, skipped, remaining}, current: "Name (phone)"|null, status: "..." }
function update(payload) {
  if (!child) return;
  writeState(payload);
}

function stop() {
  if (!child) return;
  writeState({ done: true });
  const toKill = child;
  child = null;
  setTimeout(() => {
    try {
      toKill.kill();
    } catch {
      /* already gone */
    }
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      /* already gone */
    }
  }, 1500);
}

// If the parent process dies mid-run (crash, force-kill) `stop()`'s graceful
// done-flag + setTimeout path never runs, and this buttonless,
// taskbar-less, always-on-top window would otherwise sit on screen with no
// way to dismiss it short of Task Manager. `process.on("exit")` only allows
// synchronous work, so this skips the graceful fade and kills immediately.
process.on("exit", () => {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  child = null;
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* already gone, or never created */
  }
});

module.exports = { start, update, stop };
