const desktop = require("./desktop");
const overlay = require("./overlay");
const campaigns = require("../db/campaigns");
const settingsDb = require("../db/settings");
const { buildMessageText } = require("../template");

// Sends via WhatsApp Desktop keyboard automation (wa/desktop.js), not
// WhatsApp Web. Cold numbers — the entire audience of this campaign — were
// verified by hand to work from Desktop but not from the Web session this
// app previously drove.
//
// WhatsApp Desktop exposes no readable UI, so nothing here can confirm a
// message actually ARRIVED. Every send is reported as 'submitted', never
// 'sent' — that gap is real and stays open. What this DOES verify, via the
// clipboard round-trip in desktop.verifyComposer(), is that the template was
// actually sitting in a real composer before Enter was ever pressed —
// evidence the paste really happened, not just that no exception was thrown.
//
// Every chat is opened the same single way: Ctrl+N, type the digits, Enter
// (desktop.openChatByNumber). An earlier version tried the whatsapp:// deep
// link first, which resolved through WhatsApp's own contact-matching before
// landing on a chat — removed on request, since that opaque lookup was
// exactly the "searching through my contacts" behaviour that wasn't wanted.
// One retry of the SAME method on a verification failure (transient hiccup,
// not a different mechanism) before giving up on that recipient.

const CONSECUTIVE_FAIL_LIMIT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomDelay(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// The batch pause can be up to 4 minutes of otherwise-uninterruptible sleep,
// and isAborted() was only ever checked at the top of the loop — so hitting
// Abort during a pause did nothing until the whole pause finished. Sleeping
// in short steps and re-checking between them makes Abort responsive
// everywhere, not just between sends.
async function abortableSleep(ms, isAborted) {
  const step = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    if (isAborted()) return;
    await sleep(Math.min(step, ms - elapsed));
    elapsed += step;
  }
}

async function sendOne(phone, text) {
  const digits = String(phone).replace(/\D/g, "");
  try {
    await desktop.resetToCleanState();
    await desktop.openChatByNumber(digits);
    await desktop.pasteIntoComposer(text);

    let v = await desktop.verifyComposer(text);
    if (!v.ok) {
      await desktop.resetToCleanState();
      await desktop.openChatByNumber(digits);
      await desktop.pasteIntoComposer(text);
      v = await desktop.verifyComposer(text);
    }

    if (!v.ok) {
      // Wipe the pasted draft before leaving — otherwise it sits in that
      // chat as an unsent message and the NEXT attempt pastes on top of it.
      await desktop.clearComposer();
      await desktop.resetToCleanState();
      return {
        outcome: "error",
        error: `composer verification failed after two attempts — got: ${JSON.stringify(
          String(v.got).slice(0, 80)
        )}`,
      };
    }

    // pressEnterToSend() cannot confirm delivery — measured directly, the
    // post-send UI state isn't safely readable this way (see the comment on
    // it in wa/desktop.js). The composer content WAS verified correct
    // immediately above, right before Enter, which is the check that's
    // actually trustworthy. Every send is honestly reported as 'submitted',
    // never 'sent' — WhatsApp Desktop gives this app no way to confirm
    // arrival, so the UI must not claim to know that.
    await desktop.pressEnterToSend();
    await desktop.closeChat();
    return { outcome: "submitted" };
  } catch (e) {
    return { outcome: "error", error: e.message || String(e) };
  }
}

async function runCampaign({ senderId, campaignId, recipients, onEvent, isAborted }) {
  // Read fresh each run rather than once at boot — the whole point of
  // moving these into the Settings panel is that a teammate can change
  // them and have the very next run use the new values.
  const settings = await settingsDb.getSettings();
  let remaining = settings.dailyCap - (await campaigns.countRecentSends(senderId));

  try {
    await desktop.focus();
  } catch (e) {
    onEvent({ type: "aborted", reason: `could not focus WhatsApp Desktop: ${e.message}` });
    // Distinguishes an internal stop from a normal finish so the caller can
    // persist the campaign's real status instead of defaulting to "done"
    // (server.js previously derived status only from the operator-abort
    // flag, so a focus failure with zero sends was still recorded as done).
    return { stoppedEarly: true, reason: "focus_failed" };
  }

  // verifyComposer/pasteIntoComposer repeatedly overwrite the clipboard for
  // the whole run; give the operator theirs back however the run ends.
  const originalClipboard = await desktop.getClipboard();
  let consecutiveFails = 0;
  let attempts = 0;

  // WhatsApp is maximised and focused for the whole run, burying the
  // browser's progress log — this always-on-top bar (wa/overlay.js) is the
  // only progress visible while that's true. It never takes focus, so it
  // can't interfere with the keystrokes it's reporting on.
  const total = recipients.filter((r) => r.state !== "skipped").length;
  const tally = { submitted: 0, unknown: 0, skipped: 0 };
  const overlayCounts = () => ({ ...tally, remaining: total - tally.submitted - tally.unknown - tally.skipped });
  overlay.start();

  let stoppedEarly = false;
  let stopReason = null;

  try {
    for (const row of recipients) {
      const base = { sno: row.sno, name: row.name, phone: row.phone };

      if (isAborted()) {
        await campaigns.updateRecipientResult(campaignId, row.sno, {
          state: "skipped",
          error: "run aborted by operator",
          sentAt: null,
        });
        onEvent({ ...base, state: "skipped", error: "run aborted by operator" });
        continue;
      }
      if (row.state === "skipped") {
        onEvent({ ...base, state: "skipped", error: row.error });
        continue;
      }
      if (remaining <= 0) {
        tally.skipped++;
        await campaigns.updateRecipientResult(campaignId, row.sno, {
          state: "skipped",
          error: "daily cap reached for this sender",
          sentAt: null,
        });
        onEvent({ ...base, state: "skipped", error: "daily cap reached for this sender" });
        overlay.update({ counts: overlayCounts(), status: "daily cap reached" });
        continue;
      }

      attempts++;
      overlay.update({ counts: overlayCounts(), current: `${row.name || "?"} (${row.phone})`, status: "sending..." });
      const text = buildMessageText(row, settings.messageTemplate, settings.nameFallback);
      const result = await sendOne(row.phone, text);

      const state = result.outcome === "submitted" ? "submitted" : "unknown";
      const errorText = result.outcome === "submitted" ? null : `send failed: ${result.error}`;
      tally[state]++;

      await campaigns.updateRecipientResult(campaignId, row.sno, {
        state,
        error: errorText,
        sentAt: state === "submitted" ? new Date() : null,
      });
      onEvent({ ...base, state, error: errorText });
      overlay.update({
        counts: overlayCounts(),
        current: `${row.name || "?"} (${row.phone})`,
        status: state === "submitted" ? "submitted" : errorText,
      });

      if (state === "submitted") {
        remaining--;
        consecutiveFails = 0;
      } else {
        consecutiveFails++;
      }

      if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
        onEvent({
          type: "aborted",
          reason: `${CONSECUTIVE_FAIL_LIMIT} consecutive failures — stopping (e.g. WhatsApp lost focus)`,
        });
        overlay.update({ status: "aborted — too many consecutive failures" });
        stoppedEarly = true;
        stopReason = "consecutive_failures";
        break;
      }

      if (attempts % settings.sendBatchSize === 0) {
        const pause = randomDelay(120000, 240000);
        onEvent({ type: "pause", ms: pause });
        overlay.update({ status: `paused ${Math.round(pause / 1000)}s before the next batch` });
        await abortableSleep(pause, isAborted);
      } else {
        const delay = randomDelay(settings.sendMinDelayMs, settings.sendMaxDelayMs);
        overlay.update({ status: `next send in ${Math.round(delay / 1000)}s` });
        await abortableSleep(delay, isAborted);
      }
    }
  } finally {
    overlay.stop();
    // getClipboard() returns null (not "") when the read itself failed —
    // setClipboard() treats null as "leave it alone" so a transient
    // PowerShell failure at the start of the run can't stomp the operator's
    // real clipboard with emptiness here.
    await desktop.setClipboard(originalClipboard);
  }

  return { stoppedEarly, reason: stopReason };
}

module.exports = { runCampaign };
