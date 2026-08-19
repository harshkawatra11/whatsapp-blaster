const path = require("path");

// A small always-on-top status window so a long campaign run stays visible
// while WhatsApp is maximised and focused for hours.
//
// Cross-platform Electron BrowserWindow, replacing the earlier
// Windows-only PowerShell WinForms implementation (runtime C# compilation,
// a NoActivateForm subclass, and a polled temp-JSON-file IPC). This is the
// right move independent of the macOS port: it deletes ~200 lines of
// PowerShell and a fragile IPC protocol in favour of the app's own
// rendering stack, which already runs cross-platform.
//
// The overlay must NEVER be able to take focus — doing so would break the
// exact keystrokes it's reporting on. `focusable: false` is Electron's
// direct equivalent of the WS_EX_NOACTIVATE extended window style the old
// WinForms subclass had to hand-roll. Deliberately no buttons on it either
// — a clickable control here would itself be a focus-stealing hazard, for
// a feature (Abort) that already exists in the browser.
//
// REGRESSION FIXED: `show: true` at construction time (the original form of
// this file) activates the WHOLE Electron app on macOS the instant the
// window appears — not just this window. Confirmed on a real Mac: the
// Blaster snapped back in front of WhatsApp microseconds after
// wa/sender.js's desktop.focus() had just put WhatsApp in front, because
// overlay.start() runs immediately after. `focusable: false` alone does not
// prevent this — activation happens at the app level before Electron gets a
// chance to honor per-window focusability. The fix is `show: false` at
// construction + `showInactive()` (Electron's documented "show without
// activating" API) once the window is ready, plus `type: "panel"` on
// darwin, which is the platform's actual non-activating floating-window
// primitive. `focusable: false` stays for the same never-steal-focus
// guarantee it always provided.
//
// Only usable inside the Electron main process (require("electron") throws
// in plain `node server.js`), and only after app.whenReady() — both are
// true in practice, since wa/sender.js's runCampaign() (the only caller of
// start/update/stop) is never reachable before main.js has created the
// main window and started the server.

let win = null;

function getBrowserWindow() {
  // Lazy + guarded the same way main.js requires electron-updater — a
  // standalone `node server.js` dev checkout must not crash importing this
  // module just because Electron isn't the host process.
  try {
    return require("electron").BrowserWindow;
  } catch {
    return null;
  }
}

// Spawns the overlay if one isn't already running. Safe to call repeatedly
// — a second start() while one is active is a no-op, matching the one-run-
// at-a-time assumption already made by the rest of the sender.
function start() {
  if (win) return;
  const BrowserWindow = getBrowserWindow();
  if (!BrowserWindow) return; // standalone `node server.js` — nothing to show

  try {
    const { screen } = require("electron");
    const area = screen.getPrimaryDisplay().workArea;
    const width = 360;
    const height = 96;

    win = new BrowserWindow({
      width,
      height,
      x: area.x + area.width - width - 16,
      y: area.y + 16,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false, // the WS_EX_NOACTIVATE equivalent — never steals focus
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      // Never true at construction — see the file-level note above. Revealed
      // via showInactive() below, once content is actually ready to paint.
      show: false,
      // "panel" is macOS's real non-activating floating-window type — a
      // window that can be visible without ever bringing its owning app
      // forward. Object-spread so this key doesn't exist at all on
      // Windows/Linux, where `type` takes an unrelated, platform-specific
      // set of values.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // "screen-saver" level + all-workspaces keeps it visible above a
    // maximised, focused WhatsApp window on macOS the same way TOPMOST +
    // WS_EX_TOOLWINDOW did on Windows; harmless no-ops on Windows.
    win.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin" && win.setVisibleOnAllWorkspaces) {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    // showInactive(), not show() — reveals the window without activating
    // the app, which show()/`show: true` both do. Waiting for
    // 'ready-to-show' also removes the blank-white-frame flash that
    // revealing before first paint would otherwise cause.
    win.once("ready-to-show", () => {
      if (!win || win.isDestroyed()) return;
      win.showInactive();
    });
    win.loadFile(path.join(__dirname, "..", "public", "overlay.html"));
    win.on("closed", () => {
      win = null;
    });
  } catch {
    // Best-effort — a failed overlay must never abort the send loop.
    win = null;
  }
}

// { counts: {submitted, unknown, skipped, remaining}, current: "Name (phone)"|null, status: "..." }
function update(payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.executeJavaScript(`window.render(${JSON.stringify(payload)})`, true).catch(() => {});
  } catch {
    /* best-effort — a missed frame just means the next update catches up */
  }
}

function stop() {
  if (!win || win.isDestroyed()) {
    win = null;
    return;
  }
  update({ done: true });
  const toClose = win;
  win = null;
  setTimeout(() => {
    try {
      if (!toClose.isDestroyed()) toClose.close();
    } catch {
      /* already gone */
    }
  }, 1500);
}

module.exports = { start, update, stop };
