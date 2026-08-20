const desktop = require("./desktop");
const overlay = require("./overlay");
const attachments = require("./attachments");
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

async function sendOne(phone, text, dryRun, posterPath) {
  const digits = String(phone).replace(/\D/g, "");
  try {
    await desktop.resetToCleanState();
    await desktop.openChatByNumber(digits);

    if (posterPath && dryRun) {
      // The image attach itself is NOT rehearsed. Measured directly:
      // desktop.discardAttachment() (double Escape) does not dismiss an
      // attached image preview — confirmed by watching a real dry run
      // leave the image and caption sitting undiscarded in a real chat.
      // Since there is no confirmed way to cancel out of that state
      // without sending, rehearsing it would leave real, undismissable
      // drafts in real chats — worse than not rehearsing it at all. A
      // dry run with a poster configured only proves the chat opens and
      // the caption text is well-formed (the plain text-only path,
      // below), and says so explicitly rather than silently skipping it.
      await desktop.pasteIntoComposer(text);
      const v = await desktop.verifyComposer(text);
      await desktop.clearComposer();
      await desktop.resetToCleanState();
      return v.ok
        ? { outcome: "rehearsed", posterNotRehearsed: true }
        : { outcome: "error", error: "rehearsal text verification failed (poster attach was not tested)" };
    }

    if (posterPath) {
      // Image path: attach, then type the caption. There is no sentinel
      // check for "did the IMAGE attach" — that oracle proved invalid
      // (WhatsApp carries composer text into the caption field, so a
      // successful attach and a failed paste looked identical to it).
      // Confirmed working via a real send, watched arrive, not clipboard
      // readback — see docs/decisions.md.
      //
      // verifyComposer(text) here only proves the CAPTION landed
      // correctly — it says nothing about whether the image itself is
      // actually attached. A caption that verifies with no image attached
      // would still report 'submitted'. Stated honestly: this catches
      // wrong-chat and lost-focus failures, same as the text path; it
      // does not catch "caption fine, image silently missing" — no
      // readable signal distinguishes that case from this codebase.
      await desktop.setClipboardImage(posterPath);
      await desktop.pasteImage();
      await desktop.pasteCaption(text);

      let cap = await desktop.verifyComposer(text);
      if (!cap.ok) {
        await desktop.discardAttachment();
        await desktop.resetToCleanState();
        await desktop.openChatByNumber(digits);
        await desktop.setClipboardImage(posterPath);
        await desktop.pasteImage();
        await desktop.pasteCaption(text);
        cap = await desktop.verifyComposer(text);
      }

      if (!cap.ok) {
        await desktop.discardAttachment();
        await desktop.resetToCleanState();
        return {
          outcome: "error",
          error: `poster caption verification failed after two attempts — got: ${JSON.stringify(
            String(cap.got).slice(0, 80)
          )}`,
        };
      }

      // dryRun is impossible here — handled above — so this always sends.
      await desktop.pressEnterToSend();
      await desktop.closeChat();
      return { outcome: "submitted" };
    }

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

    if (dryRun) {
      // The whole point of a rehearsal: prove the message would have gone
      // through (the composer held exactly the right text) WITHOUT
      // actually pressing Enter. Wipe the draft so nothing is left behind
      // in a real chat — a dry run must be indistinguishable from never
      // having opened that chat at all, from the recipient's side.
      await desktop.clearComposer();
      await desktop.resetToCleanState();
      return { outcome: "rehearsed" };
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
    await desktop.discardAttachment().catch(() => {});
    await desktop.resetToCleanState().catch(() => {});
    return { outcome: "error", error: e.message || String(e) };
  }
}

// Resolves the ONE poster (if any) that applies to this whole run. There is
// no per-row CSV override anymore — a CSV's POSTER LINK column (if present)
// is ignored entirely, on explicit operator request, after a real incident:
// a teammate uploaded an image on the starter screen, but a stale POSTER
// LINK column in that event's CSV silently overrode it per-row with no
// indication in the UI, so the wrong image went out. One setting, one
// source of truth, removes the whole class of confusion. The setting
// itself is EITHER a Drive link OR a directly-uploaded local image
// (mutually exclusive — enforced where it's saved: server.js's
// /api/settings/poster-upload clears posterLink on upload, and the UI
// disables the link field while an upload is active). If both were somehow
// non-empty, the upload wins — it's already sitting on disk with nothing
// to fetch.
function effectivePoster(settings) {
  if (settings.posterUploadFilename) return { kind: "local", filename: settings.posterUploadFilename };
  if (settings.posterLink) return { kind: "link", link: settings.posterLink };
  return null;
}

// Resolves the single event-level poster ONCE before the send loop starts
// (not once per recipient — a dead link or a deleted upload fails
// identically for everyone using it, better to find that once, up front).
// A link is downloaded via attachments.js; a local upload is just
// confirmed still present on disk (no network involved). Returns
// { ok, path } / { ok:false, error }, or null when no poster is configured.
async function preflightPoster(settings, onEvent) {
  attachments.clearMemoryCache();
  const poster = effectivePoster(settings);
  if (!poster) return null;

  const result =
    poster.kind === "local" ? attachments.resolveLocalPoster(poster.filename) : await attachments.downloadDriveFile(poster.link);
  if (!result.ok) {
    const label = poster.kind === "local" ? "uploaded poster" : `poster image (${poster.link})`;
    onEvent({ type: "warning", message: `${label} unavailable: ${result.error}` });
  }
  return result;
}

async function runCampaign({ senderId, campaignId, recipients, onEvent, isAborted, dryRun }) {
  // Read fresh each run rather than once at boot — the whole point of
  // moving these into the Settings panel is that a teammate can change
  // them and have the very next run use the new values.
  const settings = await settingsDb.getSettings();
  let remaining = settings.dailyCap - (await campaigns.countRecentSends(senderId));

  // focus() now runs BEFORE any network I/O (poster preflight, below) —
  // previously preflight ran first, so pressing Send Invites could sit for
  // many seconds (up to a 30s download timeout) with WhatsApp never coming
  // to the foreground and the app looking frozen. Bringing WhatsApp up
  // first means the operator sees something happen immediately, and the
  // overlay (started right after) explains the poster-download pause
  // instead of leaving a dead-looking window.
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
  const tally = { submitted: 0, unknown: 0, skipped: 0, rehearsed: 0 };
  const overlayCounts = () => ({
    ...tally,
    remaining: total - tally.submitted - tally.unknown - tally.skipped - tally.rehearsed,
  });
  overlay.start();
  overlay.update({ status: "preparing poster…" });

  let stoppedEarly = false;
  let stopReason = null;

  try {
    // Poster preflight moved here, inside the try/finally that owns
    // overlay.stop() + the clipboard restore — it now runs AFTER focus()
    // and overlay.start(), so a slow or dead Drive link shows as a live
    // "preparing poster…" status instead of a silent pre-focus stall.
    const posterResult = await preflightPoster(settings, onEvent);

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

      let result;
      if (posterResult && !posterResult.ok) {
        // Already logged loudly once at preflight — don't retry the same
        // resolution per recipient, just report the consequence.
        result = { outcome: "error", error: `poster unavailable: ${posterResult.error || "unavailable"}` };
      } else {
        result = await sendOne(row.phone, text, dryRun, posterResult?.path);
      }

      const state =
        result.outcome === "submitted" ? "submitted" : result.outcome === "rehearsed" ? "rehearsed" : "unknown";
      const succeeded = state === "submitted" || state === "rehearsed";
      // A rehearsal with a poster configured never tests the image attach
      // itself (see sendOne) — say so on every such line, not just once,
      // so it can't be missed reading the log after the fact.
      const errorText = succeeded
        ? result.posterNotRehearsed
          ? "poster attach was not rehearsed — only the message text was checked"
          : null
        : `send failed: ${result.error}`;

      // tally[state]++ always runs — it only drives the overlay's live
      // progress display. What must NOT happen during a dry run is a DB
      // write: no recipient-state change, no persisted record that
      // anything was attempted. It must be indistinguishable from never
      // having run at all, apart from the log line the operator sees.
      tally[state]++;
      if (!dryRun) {
        await campaigns.updateRecipientResult(campaignId, row.sno, {
          state,
          error: errorText,
          sentAt: state === "submitted" ? new Date() : null,
        });
      }
      onEvent({ ...base, state, error: errorText });
      overlay.update({
        counts: overlayCounts(),
        current: `${row.name || "?"} (${row.phone})`,
        status: succeeded ? state : errorText,
      });

      if (succeeded) {
        if (!dryRun) remaining--;
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
