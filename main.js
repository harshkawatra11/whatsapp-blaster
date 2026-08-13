const path = require("path");
const { app, BrowserWindow, dialog, shell, systemPreferences } = require("electron");
const updateStatus = require("./update-status");
const platformStatus = require("./platform-status");

// Pinned explicitly, before app.getPath('userData') is ever read, so the
// database path can never drift if the display name (productName) changes
// in a future package.json edit — app.getName() would otherwise silently
// follow it, and the SQLite file (and the user's saved template) would
// appear to "vanish" on that user's next launch.
app.setName("whatsapp-blaster");

// Packaged apps must write their SQLite file under the per-user AppData
// directory, never inside the (read-only) install folder — this has to be
// set before server.js (and therefore db/pool.js) is ever required.
process.env.WABLASTER_DB_PATH = path.join(app.getPath("userData"), "whatsapp-blaster.sqlite3");

// Listen on an OS-assigned free port rather than hardcoding 3000 — a
// teammate's machine may already have something bound to it.
process.env.PORT = "0";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch shouldn't start a rival server against the same SQLite
  // file — just hand focus back to the window that's already running.
  app.quit();
} else {
  let mainWindow = null;
  let serverOrigin = null;
  // Lifted out of createWindow — checkForUpdates (defined below, outside
  // createWindow) needs it for the "send-finished"/"install-update"
  // listeners, and it must only ever be required/wired up once anyway.
  let events = null;

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // http(s) only — shell.openExternal hands the string straight to the OS
  // shell, which on Windows also resolves file:// UNC paths and any
  // registered protocol handler (ms-msdt:, search-ms:, etc). Nothing in
  // this renderer should ever need to open one of those.
  function isSafeExternalUrl(url) {
    try {
      const { protocol } = new URL(url);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }

  async function createWindow() {
    let startServer;
    try {
      ({ startServer, events } = require("./server.js"));
    } catch (e) {
      dialog.showErrorBox("WhatsApp Blaster — failed to start", String(e.stack || e));
      app.quit();
      return;
    }

    let server;
    try {
      server = await startServer();
    } catch (e) {
      dialog.showErrorBox("WhatsApp Blaster — failed to start", String(e.stack || e));
      app.quit();
      return;
    }

    const { port } = server.address();
    serverOrigin = `http://127.0.0.1:${port}`;

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 860,
      minHeight: 640,
      title: "WhatsApp Blaster",
      icon: path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    mainWindow.loadURL(serverOrigin);

    // Anything the app tries to open as a new window (e.g. a target="_blank"
    // link) should go to the OS browser, not spawn another Electron window —
    // and only for http(s) links.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) shell.openExternal(url);
      return { action: "deny" };
    });

    // Nothing in this app should ever navigate the main window away from
    // its own local server — without this guard, a compromised or injected
    // page could navigate to a remote origin and inherit the window (and
    // the same unvalidated-URL openExternal handler above).
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(serverOrigin)) event.preventDefault();
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    wireCoreListeners();
    checkForUpdates();
    if (process.platform === "darwin") startAccessibilityPolling();
  }

  // Registered once, outside createWindow — previously inside it, so a
  // second createWindow() call (macOS activate with no windows) would stack
  // duplicate listeners and double-fire every future check/prompt.
  let coreListenersWired = false;
  function wireCoreListeners() {
    if (coreListenersWired) return;
    coreListenersWired = true;

    // A campaign run ending is a natural quiet moment to re-check for
    // updates — applies to both the Windows (electron-updater) and macOS
    // (manual GitHub check) paths, so it lives here rather than inside
    // either platform branch.
    events.on("send-finished", () => checkForUpdates());

    // The macOS banner's "Download" button (manual-available state) — no
    // download/install to do, just open the release page in the OS
    // browser, through the same isSafeExternalUrl-guarded path as any
    // other external link this app opens.
    events.on("open-release-page", () => {
      const { url } = updateStatus.get();
      if (url && isSafeExternalUrl(url)) shell.openExternal(url);
    });

    // The macOS Accessibility-permission card's "Grant access" button.
    // isTrustedAccessibilityClient(true) shows the OS prompt if it hasn't
    // been shown before; either way, also deep-link to the right System
    // Settings pane, since a user who already dismissed the prompt once
    // won't see it again and needs a manual route back to it.
    events.on("request-accessibility", () => {
      if (process.platform !== "darwin") return;
      systemPreferences.isTrustedAccessibilityClient(true);
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    });
  }

  // Polled, not event-driven — Electron has no change notification for TCC
  // grants, and this app cannot send a single message on macOS without this
  // permission, so it's worth checking periodically rather than only at
  // launch (a user can grant it, or macOS can revoke it on an update,
  // mid-session). Stops once trusted; a later revoke would only be caught
  // on the next launch, which matches the "check periodically, not
  // continuously forever" spirit without an unbounded interval running.
  function startAccessibilityPolling() {
    const check = () => {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      platformStatus.set({ accessibilityTrusted: trusted });
      return trusted;
    };
    if (check()) return;
    const timer = setInterval(() => {
      if (check()) clearInterval(timer);
    }, 5000);
  }

  let updateWiredUp = false;

  // Compares two "x.y.z" strings. Only used for the macOS manual-update
  // check (Windows delegates entirely to electron-updater, which does its
  // own comparison) — a tiny local implementation avoids adding a semver
  // dependency for one comparison.
  function isNewerVersion(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na > nb;
    }
    return false;
  }

  // macOS cannot auto-update for free: Squirrel.Mac (electron-updater's
  // macOS mechanism) hard-requires a valid Developer ID signature, and this
  // app is unsigned (no paid Apple account). Rather than silently doing
  // nothing, this checks the GitHub Releases API directly and — if a newer
  // tag exists — offers a "Download" link to the release page. No
  // latest-mac.yml is ever published (see .github/workflows/release.yml),
  // so there's nothing here for electron-updater to even attempt.
  async function checkForUpdatesMac() {
    updateStatus.set({ currentVersion: app.getVersion() });
    try {
      const pkg = require("./package.json");
      const { owner, repo } = pkg.build.publish;
      updateStatus.set({ state: "checking", error: null });
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "whatsapp-blaster" },
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const data = await res.json();
      const latest = String(data.tag_name || "").replace(/^v/, "");
      if (latest && isNewerVersion(latest, app.getVersion())) {
        updateStatus.set({
          state: "manual-available",
          version: latest,
          url: data.html_url || `https://github.com/${owner}/${repo}/releases`,
        });
      } else {
        updateStatus.set({ state: "up-to-date" });
      }
    } catch (e) {
      // Never blocks the app — a failed check (offline, rate-limited) just
      // leaves the banner absent until the next check.
      updateStatus.set({ state: "error", error: e.message || String(e) });
    }
  }

  function checkForUpdates() {
    if (process.platform === "darwin") {
      checkForUpdatesMac();
      return;
    }

    // Requiring this lazily and guarding with a try/catch means a dev
    // checkout without a packaged build (no update feed configured) never
    // crashes the app — electron-updater throws when it can't find feed
    // config outside a real build.
    try {
      const { autoUpdater } = require("electron-updater");
      updateStatus.set({ currentVersion: app.getVersion() });

      if (!updateWiredUp) {
        updateWiredUp = true;
        autoUpdater.autoInstallOnAppQuit = true;

        // checkForUpdatesAndNotify() only shows an easy-to-miss OS-level
        // notification, and only after the download finishes — nothing for
        // "checking" or "downloading". These handlers feed update-status.js
        // instead, which server.js exposes to the in-app banner.
        autoUpdater.on("checking-for-update", () => updateStatus.set({ state: "checking", error: null }));
        autoUpdater.on("update-not-available", () => updateStatus.set({ state: "up-to-date" }));
        autoUpdater.on("update-available", (info) =>
          updateStatus.set({ state: "available", version: info.version, percent: 0 })
        );
        autoUpdater.on("download-progress", (p) =>
          updateStatus.set({ state: "downloading", percent: Math.round(p.percent) })
        );
        autoUpdater.on("update-downloaded", (info) =>
          updateStatus.set({ state: "downloaded", version: info.version, percent: 100 })
        );
        autoUpdater.on("error", (e) => updateStatus.set({ state: "error", error: e.message || String(e) }));

        // The in-app banner's "Restart & install now" button, relayed
        // through server.js (no direct IPC channel — see update-status.js).
        // "send-finished" re-checks are wired once for both platforms in
        // wireCoreListeners(), not here.
        events.on("install-update", () => autoUpdater.quitAndInstall(true, true));
      }

      autoUpdater.checkForUpdates().catch((e) => {
        updateStatus.set({ state: "error", error: e.message || String(e) });
        console.error("Update check failed:", e.message || e);
      });
    } catch (_) {
      // Not a big deal in dev — updates only matter for packaged builds.
    }
  }

  app.whenReady().then(createWindow).catch((e) => {
    dialog.showErrorBox("WhatsApp Blaster — failed to start", String(e && e.stack ? e.stack : e));
    app.quit();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
