const path = require("path");
const { app, BrowserWindow, dialog, shell } = require("electron");
const updateStatus = require("./update-status");

// Pinned explicitly, before app.getPath('userData') is ever read, so the
// database path can never drift if the display name (productName) changes
// in a future package.json edit — app.getName() would otherwise silently
// follow it, and the SQLite file (and the user's saved template) would
// appear to "vanish" on that user's next launch.
app.setName("rys-whatsapp-blaster");

// Packaged apps must write their SQLite file under the per-user AppData
// directory, never inside the (read-only) install folder — this has to be
// set before server.js (and therefore db/pool.js) is ever required.
process.env.RYS_DB_PATH = path.join(app.getPath("userData"), "rys-whatsapp-blaster.sqlite3");

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
      dialog.showErrorBox("RYS WhatsApp Blaster — failed to start", String(e.stack || e));
      app.quit();
      return;
    }

    let server;
    try {
      server = await startServer();
    } catch (e) {
      dialog.showErrorBox("RYS WhatsApp Blaster — failed to start", String(e.stack || e));
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
      title: "RYS WhatsApp Blaster",
      icon: path.join(__dirname, "build", "icon.ico"),
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

    checkForUpdates();
  }

  // Registered once, outside createWindow — previously inside it, so a
  // second createWindow() call (macOS activate with no windows) would stack
  // a duplicate "send-finished" listener and double-fire every future check.
  let updateWiredUp = false;

  function checkForUpdates() {
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

        // A campaign run ending is a natural quiet moment to re-check —
        // registered once here, not per-window.
        events.on("send-finished", () => checkForUpdates());
        // The in-app banner's "Restart & install now" button, relayed
        // through server.js (no direct IPC channel — see update-status.js).
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
    dialog.showErrorBox("RYS WhatsApp Blaster — failed to start", String(e && e.stack ? e.stack : e));
    app.quit();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
