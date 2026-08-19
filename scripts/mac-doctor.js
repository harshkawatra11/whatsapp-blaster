#!/usr/bin/env node
// Interactive macOS verification harness for wa/desktop.mac.js.
//
// The osascript layer was written on Windows and has never run against
// real WhatsApp for Mac — see wa/desktop.mac.js's header. This script is
// what turns that "unverified" state into a short, structured tuning
// session instead of a rewrite: it walks every primitive in the same order
// wa/sender.js uses them, pausing after each step for a plain-English
// "did that actually happen?" so a wrong TIMINGS value or a wrong keystroke
// is caught immediately, one step at a time, against a real chat.
//
// Deliberately NEVER presses Enter on a real composer — same rehearsal
// discipline used throughout the Windows-side development of this app.

const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

if (process.platform !== "darwin") {
  console.error("mac:doctor only runs on macOS.");
  process.exit(1);
}

const desktop = require("../wa/desktop.mac.js");

const rl = readline.createInterface({ input, output });
async function ask(question) {
  return (await rl.question(question)).trim();
}
async function confirm(question) {
  const a = await ask(`${question} (y/n) `);
  return a.toLowerCase().startsWith("y");
}

function runOsascriptRaw(script) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("osascript", ["-"], { input: script, encoding: "utf8" });
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

async function main() {
  console.log("=== WhatsApp Blaster — macOS doctor ===\n");

  // 1. Bundle identifier — desktop.mac.js hardcodes net.whatsapp.WhatsApp;
  // confirm it against whatever is actually installed on this machine, in
  // case a future WhatsApp release changed it.
  const idCheck = runOsascriptRaw('id of app "WhatsApp"');
  if (idCheck.code === 0) {
    console.log(`WhatsApp bundle id on this machine: ${idCheck.stdout}`);
    if (idCheck.stdout !== desktop.WHATSAPP_BUNDLE_ID) {
      console.log(
        `  MISMATCH — wa/desktop.mac.js has WHATSAPP_BUNDLE_ID = "${desktop.WHATSAPP_BUNDLE_ID}". Update it.`
      );
    } else {
      console.log("  Matches wa/desktop.mac.js. Good.");
    }
  } else {
    console.log("Could not resolve WhatsApp's bundle id — is it installed as /Applications/WhatsApp.app?");
    console.log(idCheck.stderr);
    process.exit(1);
  }

  const running = await desktop.isRunning();
  console.log(`WhatsApp running: ${running}`);
  if (!running) {
    console.log("Open WhatsApp for Mac and sign in before continuing.");
    process.exit(1);
  }

  // 2. Accessibility probe. `keystroke` is the one command in this file
  // that's gated on it; a trivial one-key probe surfaces error -1002 in
  // plain English instead of a cryptic failure deep in a real send.
  console.log("\nChecking Accessibility permission...");
  const probe = runOsascriptRaw('tell application "System Events" to keystroke ""');
  if (probe.code !== 0 && /1002|not allowed/i.test(probe.stderr)) {
    console.log("  NOT granted. Open System Settings → Privacy & Security → Accessibility,");
    console.log("  and add/enable whatever process is running this script (Terminal, or");
    console.log("  WhatsApp Blaster.app once packaged). Re-run this script after granting it.");
    process.exit(1);
  }
  console.log("  Granted. Good.\n");

  const digits = await ask("Enter a SAFE TEST phone number, digits only (country code included): ");
  if (!digits || !/^\d+$/.test(digits)) {
    console.log("No valid digits entered — aborting.");
    process.exit(1);
  }

  console.log("\nCurrent TIMINGS (from wa/desktop.mac.js):");
  console.log(JSON.stringify(desktop.TIMINGS, null, 2));
  console.log("\nIf a step below feels too fast/slow, note it — after the run, edit the");
  console.log("matching entry directly in wa/desktop.mac.js and re-run this script.\n");

  console.log("Step 1: focus()");
  await desktop.focus();
  await confirm("  Did WhatsApp come to the foreground?");

  console.log("\nStep 2: openChatByNumber() — Cmd+N, Tab x2, type digits, Down arrow, Return");
  await desktop.openChatByNumber(digits);
  const chatOpened = await confirm("  Did the correct chat open?");
  if (!chatOpened) {
    console.log("  Stop here and tune TIMINGS.afterNewChat / afterDigits / afterChatOpen, then re-run.");
    process.exit(0);
  }

  console.log("\nStep 3: pasteIntoComposer() — pastes a harmless test sentence");
  await desktop.pasteIntoComposer("WhatsApp Blaster mac:doctor test — safe to ignore, not sent.");
  await confirm("  Did the text appear in the composer?");

  console.log("\nStep 4: verifyComposer() — the same oracle the real send loop uses");
  const v = await desktop.verifyComposer("WhatsApp Blaster mac:doctor test — safe to ignore, not sent.");
  console.log(`  ok=${v.ok} score=${v.score.toFixed(3)}`);
  console.log(`  got back: ${JSON.stringify(v.got)}`);

  console.log("\nStep 5: clearComposer() — clears the test text without sending");
  await desktop.clearComposer();
  await confirm("  Is the composer empty now?");

  console.log("\nStep 6: resetToCleanState() / closeChat() — Escape");
  await desktop.resetToCleanState();

  console.log("\nDeliberately NOT testing pressEnterToSend() — this tool never sends for real.");
  console.log("If everything above looked right, the primitives are sound. Poster-image");
  console.log("attach (setClipboardImage/pasteImage/pasteCaption/discardAttachment) still");
  console.log("needs a manual check against a real image file — this script doesn't have");
  console.log("one handy to test with.");

  rl.close();
}

main().catch((e) => {
  console.error("\nFailed:", e.message || e);
  rl.close();
  process.exit(1);
});
