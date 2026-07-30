const path = require("path");
const { app, BrowserWindow, dialog, shell } = require("electron");

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

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  async function createWindow() {
    let startServer;
    try {
      ({ startServer } = require("./server.js"));
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
      },
    });

    mainWindow.loadURL(`http://127.0.0.1:${port}`);

    // Anything the app tries to open as a new window (e.g. a target="_blank"
    // link) should go to the OS browser, not spawn another Electron window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    checkForUpdates();
  }

  function checkForUpdates() {
    // Requiring this lazily and guarding with a try/catch means a dev
    // checkout without a packaged build (no update feed configured) never
    // crashes the app — electron-updater throws when it can't find feed
    // config outside a real build.
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch (_) {
      // Not a big deal in dev — updates only matter for packaged builds.
    }
  }

  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
