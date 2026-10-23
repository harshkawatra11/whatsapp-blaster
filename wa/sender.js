const desktop = require("./desktop");
const overlay = require("./overlay");
const attachments = require("./attachments");
const campaigns = require("../db/campaigns");
const settingsDb = require("../db/settings");
const { buildMessageText } = require("../template");
const pacing = require("../pacing");

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
//
// v1.6.0 humanisation: pacing comes from a named profile (pacing.js),
// with randomised gaps, randomly-spaced breaks and daily/hourly caps. The
// first line of every message is typed key by key (composeLikeHuman), every
// keystroke wait is jittered, and an opening Hi/Hello is varied per
// recipient. None of this changes WHAT is verified: the full message is still
// checked in the composer before Enter.

const CONSECUTIVE_FAIL_LIMIT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sleeps in short steps so Abort (and Pause) are responsive everywhere, not
// just between sends: a break can be 15 minutes of otherwise
// uninterruptible sleep. While paused, the clock stops, so a 40s gap with a
// 5-minute pause in the middle still waits 40s of un-paused time after
// Resume. onPauseChange fires on each paused/unpaused transition so the
// caller can log it and update the overlay.
async function abortableSleep(ms, isAborted, isPaused = () => false, onPauseChange = () => {}) {
  const step = 500;
  let elapsed = 0;
  let wasPaused = false;
  while (elapsed < ms) {
    if (isAborted()) return;
    const chunk = Math.min(step, ms - elapsed);
    await sleep(chunk);
    const pausedNow = isPaused();
    if (pausedNow !== wasPaused) {
      onPauseChange(pausedNow);
      wasPaused = pausedNow;
    }
    if (!pausedNow) elapsed += chunk;
  }
}

// Blocks while the operator has the run paused. Called before each
// recipient, so a Pause pressed mid-message takes effect as soon as that
// message finishes.
async function waitWhilePaused(isAborted, isPaused, onPauseChange) {
  if (!isPaused()) return;
  onPauseChange(true);
  while (isPaused() && !isAborted()) await sleep(500);
  if (!isAborted()) onPauseChange(false);
}

// Puts `text` in the open chat's composer the way a person would (v1.6.0):
// the first line typed key by key, the blank lines after it as Shift+Enter,
// the rest pasted. If the first line isn't safe to type
// (pacing.splitForTyping: emoji, non-Latin script, ":" etc.), the whole
// message is pasted exactly as before. Verification is unchanged and still
// checks the FULL text before Enter.
async function composeLikeHuman(text) {
  const { head, lineBreaks, body } = pacing.splitForTyping(text);
  if (!head) {
    await desktop.pasteIntoComposer(text);
    return;
  }
  await desktop.clearComposer();
  await desktop.typeText(head, lineBreaks);
  // pasteCaption is the non-clearing paste. Reused here deliberately,
  // because pasteIntoComposer's select-all + delete would wipe the line
  // just typed.
  if (body) await desktop.pasteCaption(body);
}

// Caption variant: no clearComposer, since select-all + delete against an
// attached-image preview could delete the image itself (see
// desktop.pasteImage).
async function captionLikeHuman(text) {
  const { head, lineBreaks, body } = pacing.splitForTyping(text);
  if (!head) {
    await desktop.pasteCaption(text);
    return;
  }
  await desktop.typeText(head, lineBreaks);
  if (body) await desktop.pasteCaption(body);
}

async function sendOne(phone, text, dryRun, posterPath) {
  const digits = String(phone).replace(/\D/g, "");
  try {
    await desktop.resetToCleanState();
    await desktop.openChatByNumber(digits);

    // A person glances at the chat before typing. Fixed zero-wait here was
    // one more machine-regular beat.
    await sleep(pacing.chatOpenPauseMs());

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
      await composeLikeHuman(text);
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
      await captionLikeHuman(text);

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
      // "Re-reading" dwell before Enter: scales with length (pacing.composeDwellMs).
      await sleep(pacing.composeDwellMs(text.length));
      await desktop.pressEnterToSend();
      await desktop.closeChat();
      return { outcome: "submitted" };
    }

    await composeLikeHuman(text);

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
    // "Re-reading" dwell before Enter: scales with length (pacing.composeDwellMs).
    await sleep(pacing.composeDwellMs(text.length));
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

async function runCampaign({ senderId, campaignId, recipients, onEvent, isAborted, isPaused = () => false, dryRun }) {
  // Read fresh each run, so a profile changed in ⚙ Settings applies to the
  // very next run (never to one already in progress).
  const settings = await settingsDb.getSettings();
  const profile = pacing.resolveProfile(settings.pacingProfile);
  let remaining = profile.dailyCap - (await campaigns.countRecentSends(senderId));

  // focus() runs BEFORE any network I/O (poster preflight, below).
  // Previously preflight ran first, so pressing Send Invites could sit for
  // many seconds (up to a 30s download timeout) with WhatsApp never coming
  // to the foreground and the app looking frozen.
  try {
    await desktop.focus();
  } catch (e) {
    onEvent({ type: "aborted", reason: `could not focus WhatsApp Desktop: ${e.message}` });
    return { stoppedEarly: true, reason: "focus_failed" };
  }

  onEvent({
    type: "info",
    message: dryRun
      ? `Sending speed: ${profile.label} (rehearsal uses short 2-4s gaps, no breaks)`
      : `Sending speed: ${profile.label}: ${Math.round(profile.gapMs[0] / 1000)}-${Math.round(
          profile.gapMs[1] / 1000
        )}s gaps, a break every ${profile.breakEvery[0]}-${profile.breakEvery[1]} messages, max ${profile.dailyCap}/day` +
        (profile.hourlyCap ? `, ${profile.hourlyCap}/hour` : ""),
  });

  // verifyComposer/pasteIntoComposer repeatedly overwrite the clipboard for
  // the whole run; give the operator theirs back however the run ends.
  const originalClipboard = await desktop.getClipboard();
  let consecutiveFails = 0;

  // WhatsApp is maximised and focused for the whole run, burying the
  // browser's progress log. This always-on-top bar (wa/overlay.js) is the
  // only progress visible while that's true. It never takes focus.
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

  // Pause bookkeeping. Pausing almost always means the operator clicked
  // back into WhatsApp Blaster (or elsewhere), so WhatsApp must be re-focused
  // before the next keystroke. pausedSinceLastSend records that.
  let pausedSinceLastSend = false;
  const onPauseChange = (paused) => {
    if (paused) {
      pausedSinceLastSend = true;
      onEvent({ type: "paused" });
      overlay.update({ status: "paused: press Resume in WhatsApp Blaster" });
    } else {
      onEvent({ type: "resumed" });
      overlay.update({ status: "resuming…" });
    }
  };
  const sleepFor = (ms) => abortableSleep(ms, isAborted, isPaused, onPauseChange);

  // A rehearsal never presses Enter, so it carries no ban risk and shouldn't
  // take hours. Real runs take a break every N sends, with N re-rolled after
  // each break so there's no fixed cadence to detect.
  let sinceBreak = 0;
  let nextBreakAt = pacing.randomBetween(profile.breakEvery[0], profile.breakEvery[1]);

  // No gap/break after the last recipient that will actually be attempted:
  // waiting a minute just to end the run helps nobody.
  let lastSendableIndex = -1;
  recipients.forEach((r, i) => {
    if (r.state !== "skipped") lastSendableIndex = i;
  });

  // A dry run must leave no trace in the DB, abort-skips included (this
  // previously wrote "skipped" rows even during a rehearsal).
  const skipAsAborted = async (row, base) => {
    if (!dryRun) {
      await campaigns.updateRecipientResult(campaignId, row.sno, {
        state: "skipped",
        error: "run aborted by operator",
        sentAt: null,
      });
    }
    onEvent({ ...base, state: "skipped", error: "run aborted by operator" });
  };

  try {
    // Poster preflight runs here, inside the try/finally that owns
    // overlay.stop() + the clipboard restore, AFTER focus() and
    // overlay.start(). A slow or dead Drive link therefore shows as a live
    // "preparing poster…" status instead of a silent pre-focus stall.
    const posterResult = await preflightPoster(settings, onEvent);

    for (let i = 0; i < recipients.length; i++) {
      const row = recipients[i];
      const base = { sno: row.sno, name: row.name, phone: row.phone };

      await waitWhilePaused(isAborted, isPaused, onPauseChange);

      if (isAborted()) {
        await skipAsAborted(row, base);
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

      // Hourly cap: wait (abortable, pausable) until the oldest send in the
      // trailing hour ages out. Real sends only, because a rehearsal records
      // nothing for the window to count anyway.
      if (!dryRun && profile.hourlyCap) {
        const waitMs = await campaigns.msUntilHourlySlot(senderId, profile.hourlyCap);
        if (waitMs > 0) {
          onEvent({ type: "pause", reason: "hourly", ms: waitMs });
          overlay.update({
            status: `hourly limit (${profile.hourlyCap}/h): resuming in ~${Math.ceil(waitMs / 60000)} min`,
          });
          await sleepFor(waitMs);
          if (isAborted()) {
            await skipAsAborted(row, base);
            continue;
          }
        }
      }

      if (pausedSinceLastSend) {
        pausedSinceLastSend = false;
        try {
          await desktop.focus();
        } catch (e) {
          onEvent({ type: "aborted", reason: `could not re-focus WhatsApp Desktop after the pause: ${e.message}` });
          overlay.update({ status: "aborted: could not re-focus WhatsApp" });
          stoppedEarly = true;
          stopReason = "focus_failed";
          break;
        }
      }

      overlay.update({ counts: overlayCounts(), current: `${row.name || "?"} (${row.phone})`, status: "sending..." });

      // varyGreeting: an opening "Hi"/"Hello" is randomly alternated per
      // recipient (template.js), so the run isn't one byte-identical message.
      const text = buildMessageText(row, settings.messageTemplate, settings.nameFallback, { varyGreeting: true });

      let result;
      if (posterResult && !posterResult.ok) {
        // Already logged loudly once at preflight. Don't retry the same
        // resolution per recipient, just report the consequence.
        result = { outcome: "error", error: `poster unavailable: ${posterResult.error || "unavailable"}` };
      } else {
        result = await sendOne(row.phone, text, dryRun, posterResult?.path);
      }

      const state =
        result.outcome === "submitted" ? "submitted" : result.outcome === "rehearsed" ? "rehearsed" : "unknown";
      const succeeded = state === "submitted" || state === "rehearsed";
      // A rehearsal with a poster configured never tests the image attach
      // itself (see sendOne). Say so on every such line, not just once.
      const errorText = succeeded
        ? result.posterNotRehearsed
          ? "poster attach was not rehearsed; only the message text was checked"
          : null
        : `send failed: ${result.error}`;

      // tally[state]++ always runs, since it only drives the overlay. What
      // must NOT happen during a dry run is a DB write.
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
          reason: `${CONSECUTIVE_FAIL_LIMIT} consecutive failures, stopping (e.g. WhatsApp lost focus)`,
        });
        overlay.update({ status: "aborted: too many consecutive failures" });
        stoppedEarly = true;
        stopReason = "consecutive_failures";
        break;
      }

      if (i >= lastSendableIndex) continue;

      if (dryRun) {
        const gap = pacing.randomBetween(2000, 4000);
        overlay.update({ status: `next rehearsal in ${Math.round(gap / 1000)}s` });
        await sleepFor(gap);
        continue;
      }

      sinceBreak++;
      if (sinceBreak >= nextBreakAt) {
        sinceBreak = 0;
        nextBreakAt = pacing.randomBetween(profile.breakEvery[0], profile.breakEvery[1]);
        const pause = pacing.randomBetween(profile.breakMs[0], profile.breakMs[1]);
        onEvent({ type: "pause", reason: "break", ms: pause });
        overlay.update({ status: `taking a ${Math.round(pause / 60000)} min break` });
        await sleepFor(pause);
      } else {
        const gap = pacing.humanGap(profile.gapMs);
        overlay.update({ status: `next send in ${Math.round(gap / 1000)}s` });
        await sleepFor(gap);
      }
    }
  } finally {
    overlay.stop();
    // getClipboard() returns null (not "") when the read itself failed, and
    // setClipboard() treats null as "leave it alone".
    await desktop.setClipboard(originalClipboard);
  }

  return { stoppedEarly, reason: stopReason };
}

module.exports = { runCampaign };
