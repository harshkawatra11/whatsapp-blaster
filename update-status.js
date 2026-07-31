// Shared update-status state, written by main.js's electron-updater event
// handlers and read by server.js's /api/update-status route. The renderer
// has no IPC channel to main (no preload script) — it's loaded over HTTP
// from the embedded Express server, so this module is the bridge: main
// writes into it directly (same process, just required from both places),
// the server reads it back out for the polling renderer.
let status = {
  state: "idle", // idle | checking | available | downloading | downloaded | error | up-to-date
  version: null, // the version being downloaded/offered, once known
  percent: null, // 0-100 while downloading
  error: null,
  currentVersion: null, // this install's own version, set once at startup
};

function get() {
  return status;
}

function set(partial) {
  status = { ...status, ...partial };
}

module.exports = { get, set };
