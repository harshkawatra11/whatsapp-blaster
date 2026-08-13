// Platform dispatcher. wa/sender.js and server.js call this module's
// 15-function contract without knowing which OS they're on — all the
// platform-specific automation lives in desktop.win.js (PowerShell/Win32,
// battle-tested) and desktop.mac.js (osascript/System Events, unverified —
// see that file's header). Neither backend is required unless its platform
// actually needs it, so a Windows machine never even parses the mac file
// and vice versa.
const CONTRACT = [
  "isRunning",
  "focus",
  "openChatByNumber",
  "pasteIntoComposer",
  "verifyComposer",
  "pressEnterToSend",
  "resetToCleanState",
  "closeChat",
  "clearComposer",
  "getClipboard",
  "setClipboard",
  "setClipboardImage",
  "pasteImage",
  "pasteCaption",
  "discardAttachment",
];

function unsupportedBackend(platform) {
  const backend = {};
  for (const name of CONTRACT) {
    backend[name] = async () => {
      throw new Error(
        `WhatsApp Blaster supports Windows and macOS only (detected "${platform}")`
      );
    };
  }
  return backend;
}

function loadBackend() {
  if (process.platform === "win32") return require("./desktop.win.js");
  if (process.platform === "darwin") return require("./desktop.mac.js");
  return unsupportedBackend(process.platform);
}

module.exports = loadBackend();
