#!/usr/bin/env node
// Diagnostic-only, not part of the app. wa/desktop.mac.js's click-to-focus
// fix (openChatByNumber) still isn't landing keystrokes in WhatsApp for
// Mac's New Chat search field after two attempts — rather than guess a
// third AppleScript blind, this dumps EVERY UI element System Events can
// see inside WhatsApp's window after Cmd+N, so the next fix is based on
// what's actually there.
//
// WhatsApp for Mac is a Mac Catalyst app (see wa/desktop.mac.js's header) —
// Catalyst apps have a real history of exposing little or nothing to the
// classic AppKit accessibility tree System Events reads from, which would
// fully explain why `entire contents` found no text field to click. This
// script's job is to prove or disprove that, not to fix anything itself.
//
// Run with: node scripts/mac-inspect-newchat.js

const { spawnSync } = require("child_process");

if (process.platform !== "darwin") {
  console.error("This is macOS-only.");
  process.exit(1);
}

const WHATSAPP_BUNDLE_ID = "net.whatsapp.WhatsApp";

function osa(script) {
  const r = spawnSync("osascript", ["-"], { input: script, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

console.log("=== WhatsApp Blaster — macOS New Chat accessibility dump ===\n");

const running = osa(`application id "${WHATSAPP_BUNDLE_ID}" is running`);
if (running.stdout !== "true") {
  console.error("WhatsApp is not running. Open it and sign in first.");
  process.exit(1);
}

console.log("Activating WhatsApp and opening New Chat (Cmd+N)...");
osa(`tell application id "${WHATSAPP_BUNDLE_ID}" to activate`);
osa(`tell application "System Events" to keystroke "n" using command down`);

// Give the panel time to fully render before inspecting it.
spawnSync("sleep", ["1.2"]);

// Dumps every element under a given window index: class, role description,
// subrole, name, description, title, value (truncated), and whether it's
// currently focused/enabled — wrapped in individual `try`s per property
// since not every class supports every attribute (asking for an
// unsupported property throws and would otherwise abort the whole dump).
function dumpWindow(index) {
  const script = `
tell application "System Events"
  tell (first process whose bundle identifier is "${WHATSAPP_BUNDLE_ID}")
    set winExists to false
    try
      if (count of windows) >= ${index} then set winExists to true
    end try
    if not winExists then return "NO_WINDOW_${index}"

    set out to ""
    set allEls to entire contents of window ${index}
    set n to count of allEls
    set out to out & "window ${index}: " & n & " total elements" & linefeed & linefeed
    repeat with el in allEls
      set line to ""
      try
        set line to line & "class=" & (class of el as string)
      end try
      try
        set line to line & " role=" & (role description of el)
      end try
      try
        set line to line & " subrole=" & (subrole of el)
      end try
      try
        set line to line & " name=" & (name of el)
      end try
      try
        set line to line & " desc=" & (description of el)
      end try
      try
        set line to line & " title=" & (title of el)
      end try
      try
        set v to value of el as string
        if (length of v) > 40 then set v to (text 1 thru 40 of v) & "..."
        set line to line & " value=\\"" & v & "\\""
      end try
      try
        set line to line & " focused=" & (focused of el)
      end try
      try
        set line to line & " enabled=" & (enabled of el)
      end try
      set out to out & line & linefeed
    end repeat
    return out
  end tell
end tell
`;
  return osa(script);
}

for (const idx of [1, 2]) {
  const result = dumpWindow(idx);
  console.log(`--- window ${idx} ---`);
  if (result.code !== 0) {
    console.log(`  osascript error: ${result.stderr}`);
  } else if (result.stdout === `NO_WINDOW_${idx}`) {
    console.log("  (no such window)");
  } else if (!result.stdout) {
    console.log("  (empty — entire contents returned nothing at all, or the call itself failed silently)");
  } else {
    console.log(result.stdout);
  }
  console.log();
}

console.log("Paste everything above back to Claude — that's what decides the next fix.");
console.log("(Closing the New Chat panel and pressing Escape is safe to do now — nothing was typed or sent.)");
