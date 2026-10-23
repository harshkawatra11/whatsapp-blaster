const db = require("./pool");
const { DEFAULT_TEMPLATE, DEFAULT_NAME_FALLBACK } = require("../template");
const { PACING_PROFILES, DEFAULT_PACING_PROFILE, isProfileKey } = require("../pacing");

// Operator settings, stored in the SQLite `settings` table rather than
// .env. A packaged app's working directory is inside a read-only install
// (or absent), so .env is unreachable there. Sending speed is chosen as one
// of three named pacing profiles (pacing.js) from the ⚙ Settings panel. The
// message template, name fallback and poster are edited in Step 1.
// defaultCountry has no UI anymore, but stays here as a backend default.
const DEFAULTS = {
  // v1.6.0: replaces sendMinDelayMs / sendMaxDelayMs / sendBatchSize /
  // dailyCap. One of the keys of pacing.js's PACING_PROFILES; that profile
  // supplies the gaps, breaks, daily cap and hourly cap together.
  pacingProfile: DEFAULT_PACING_PROFILE,
  defaultCountry: "91",
  messageTemplate: DEFAULT_TEMPLATE,
  nameFallback: DEFAULT_NAME_FALLBACK,
  // Event-level poster link — this is "the place to add it" for an event
  // whose CSV doesn't carry a POSTER LINK column (or whose per-row link has
  // gone stale, e.g. a deleted Drive file). Empty string means "none
  // configured" — sending stays text-only. A CSV row's own posterLink, when
  // present, overrides this per-row (wa/sender.js); this is the fallback,
  // not an override of it.
  posterLink: "",
  // Set instead of posterLink when the operator uploads an image directly
  // rather than pasting a Drive link — just the filename under
  // data/local-poster/ (wa/attachments.js resolves it to an absolute path).
  // Mutually exclusive with posterLink in practice (enforced by the
  // /api/settings/poster-upload route clearing posterLink on upload, and
  // by the UI disabling the link field while this is set) — wa/sender.js's
  // effectivePoster() treats a non-empty value here as taking precedence.
  posterUploadFilename: "",
};

async function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = { ...DEFAULTS, ...stored };
  // A stale or hand-edited value must never leave a run without a pacing
  // profile. Fall back to the default rather than failing the send.
  if (!isProfileKey(merged.pacingProfile)) merged.pacingProfile = DEFAULT_PACING_PROFILE;
  return merged;
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };

  if (!isProfileKey(next.pacingProfile)) {
    throw new Error(
      `Unknown sending speed "${next.pacingProfile}". Pick one of: ${Object.keys(PACING_PROFILES).join(", ")}`
    );
  }

  // defaultCountry was previously unvalidated and flowed straight into
  // phone-number construction (wa/audience.js) — garbage in here silently
  // corrupted every 10-digit phone in the next uploaded CSV.
  const country = String(next.defaultCountry ?? "").trim();
  if (!/^\d{1,4}$/.test(country)) {
    throw new Error("Default country code must be 1-4 digits, no + or spaces");
  }
  next.defaultCountry = country;

  const template = String(next.messageTemplate ?? "").trim();
  if (!template) {
    throw new Error("Message template cannot be empty");
  }
  next.messageTemplate = String(next.messageTemplate);

  next.nameFallback = String(next.nameFallback ?? DEFAULT_NAME_FALLBACK).trim() || DEFAULT_NAME_FALLBACK;

  // Optional (empty string is valid — "no poster configured for this
  // event"), but if something IS provided it must at least be a
  // well-formed URL, so a typo doesn't sit unnoticed until preflight fails
  // every single recipient.
  {
    const val = String(next.posterLink ?? "").trim();
    if (val) {
      try {
        new URL(val);
      } catch {
        throw new Error("Poster link is not a valid URL");
      }
    }
    next.posterLink = val;
  }

  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  db.exec("BEGIN");
  try {
    for (const key of Object.keys(DEFAULTS)) {
      upsert.run(key, String(next[key]));
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* BEGIN may not have taken effect — the original error is what matters */
    }
    throw e;
  }
  return next;
}

// Writes messageTemplate into the DB once, on first run only, rather than
// letting it fall back to DEFAULT_TEMPLATE at read time like the other
// settings do. This matters specifically for the template: if it only ever
// fell back to the code default, shipping an update with different default
// wording would silently rewrite the message for every user who had never
// edited it themselves. Seeding makes the DB row the sole source of truth
// from the very first launch — "not one word changes" until a user
// explicitly edits and saves.
function seedTemplateIfMissing() {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("messageTemplate");
  if (row) return;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`
  ).run("messageTemplate", DEFAULT_TEMPLATE);
}

const POSTER_RESET_MARKER = "posterResetV150";

// One-time migration, v1.5.0: clears every existing install's saved poster
// (Drive link AND uploaded file) exactly once, so nobody keeps sending
// whatever image happened to be configured under the old per-row CSV
// override bug (see docs/decisions.md — a stale POSTER LINK column could
// silently override an uploaded image with no indication in the UI). After
// this runs, every teammate's poster is genuinely blank until they set one
// deliberately. Guarded by presence of the marker key — same idiom as
// seedTemplateIfMissing, run-once via "does this key already exist".
//
// `deleteLocalFile` is injected rather than imported so this module never
// has to require wa/attachments.js — db/ modules don't depend on wa/
// modules anywhere else in the codebase, and this shouldn't be the first
// exception. server.js (which already requires both) passes
// attachments.deleteLocalPoster in.
function clearStalePosterOnce(deleteLocalFile) {
  const marker = db.prepare("SELECT value FROM settings WHERE key = ?").get(POSTER_RESET_MARKER);
  if (marker) return;

  const uploaded = db.prepare("SELECT value FROM settings WHERE key = ?").get("posterUploadFilename");
  if (uploaded?.value) deleteLocalFile(uploaded.value);

  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  db.exec("BEGIN");
  try {
    upsert.run("posterLink", "");
    upsert.run("posterUploadFilename", "");
    upsert.run(POSTER_RESET_MARKER, "1");
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* BEGIN may not have taken effect — the original error is what matters */
    }
    throw e;
  }
}

// v1.6.0 cleanup: the free-form pacing keys replaced by pacingProfile. Plain
// idempotent DELETEs with no marker key needed, since deleting an absent row
// is a no-op. This leaves no stale "0/0 delay" rows behind to confuse anyone
// reading the DB.
const RETIRED_SETTING_KEYS = ["sendMinDelayMs", "sendMaxDelayMs", "sendBatchSize", "dailyCap"];

function dropRetiredSettings() {
  const del = db.prepare("DELETE FROM settings WHERE key = ?");
  for (const key of RETIRED_SETTING_KEYS) del.run(key);
}

module.exports = { getSettings, saveSettings, seedTemplateIfMissing, clearStalePosterOnce, dropRetiredSettings };
