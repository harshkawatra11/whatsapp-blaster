// Shared platform-status state, written by main.js and read by server.js's
// /api/platform-status route — same bridge pattern as update-status.js,
// needed for the same reason: the renderer has no IPC channel to Electron's
// main process (no preload script), so anything main.js learns has to be
// relayed through this server-owned module instead of a direct channel.
//
// Exists specifically for macOS: unlike Windows, WhatsApp Blaster cannot
// send a single message on a Mac until the user grants Accessibility
// permission (System Events keystroke commands are gated on it, pasteboard
// reads/writes are not). Without this, that failure would surface only as
// an opaque "not focused" error on the first real send.
let status = {
  platform: process.platform,
  accessibilityTrusted: null, // null until main.js checks (non-macOS: stays null, unused)
};

function get() {
  return { ...status };
}

function set(partial) {
  status = { ...status, ...partial };
}

module.exports = { get, set };
