const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Local, offline database. No server, no credentials, no network — a single
// file. Node's built-in node:sqlite (stable since Node 22.5, and Electron's
// bundled Node is well above that) needs zero packages and zero native
// compilation, which also means the packaged app has NO native modules at
// all to go stale across an Electron upgrade.
//
// WABLASTER_DB_PATH is set by the Electron main process to a path under
// app.getPath('userData') for the packaged app. Falls back to a local file
// for plain `node server.js` development.
const dbPath = process.env.WABLASTER_DB_PATH || path.join(__dirname, "..", "data", "whatsapp-blaster.sqlite3");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

// SQLite disables foreign-key enforcement per-connection by default, unlike
// Postgres. Without this, ON DELETE CASCADE (recipients -> campaigns) is
// silently a no-op.
db.exec("PRAGMA foreign_keys = ON");

module.exports = db;
