const db = require("./pool");
const { DEFAULT_TEMPLATE, DEFAULT_NAME_FALLBACK } = require("../template");

// User-tunable send settings, editable from the app's Settings panel. This
// replaces .env-only pacing config — a packaged app's working directory is
// inside a read-only install (or absent), so .env is unreachable there.
// Deliberately no hard ceiling on any of these, per the original product
// requirement ("sensible defaults shown in the UI, every limit editable").
const DEFAULTS = {
  // Changed from 8000/20000 at explicit operator request: the automation
  // steps themselves (open chat ~3s, paste+verify ~3s, send ~2s — see
  // wa/desktop.win.js's TIMINGS-equivalent Start-Sleep calls) already take
  // about 8s per recipient, and that WAS the dominant cost; the randomised
  // 8-20s gap this replaces was stacked ON TOP of that, which is what made
  // ~4-5 recipients take ~2 minutes. Zero here means "move to the next
  // recipient the instant this one's automation finishes" — no added idle
  // wait. This removes the app's main defence against looking automated
  // (see docs/operations.md) — raising it back is just a Settings-panel
  // edit, no code change, if send-safety turns out to matter more than
  // speed for a given number.
  sendMinDelayMs: 0,
  sendMaxDelayMs: 0,
  sendBatchSize: 50,
  dailyCap: 200,
  defaultCountry: "91",
  messageTemplate: DEFAULT_TEMPLATE,
  nameFallback: DEFAULT_NAME_FALLBACK,
  // Event-level poster/brochure links — this is "the place to add it" for
  // an event whose CSV doesn't carry a POSTER LINK / ATTACHMENT LINK
  // column (or whose per-row link has gone stale, e.g. a deleted Drive
  // file). Empty string means "none configured" — sending stays text-only.
  // A CSV row's own posterLink/brochureLink, when present, overrides this
  // per-row (wa/sender.js); this is the fallback, not an override of it.
  posterLink: "",
  brochureLink: "",
  // Set instead of posterLink when the operator uploads an image directly
  // rather than pasting a Drive link — just the filename under
  // data/local-poster/ (wa/attachments.js resolves it to an absolute path).
  // Mutually exclusive with posterLink in practice (enforced by the
  // /api/settings/poster-upload route clearing posterLink on upload, and
  // by the UI disabling the link field while this is set) — wa/sender.js's
  // effectivePoster() treats a non-empty value here as taking precedence.
  posterUploadFilename: "",
};

const NUMERIC_KEYS = new Set(["sendMinDelayMs", "sendMaxDelayMs", "sendBatchSize", "dailyCap"]);

async function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = { ...DEFAULTS, ...stored };
  for (const key of NUMERIC_KEYS) {
    const n = Number(merged[key]);
    // A corrupt/non-numeric stored value previously became NaN here and
    // silently disabled whatever depended on it downstream — e.g.
    // `remaining = dailyCap - sent` becomes NaN, and `NaN <= 0` is false,
    // so the daily cap stopped applying with no error anywhere.
    merged[key] = Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return merged;
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };

  // Type-checking MUST run before the min/max comparison below. String
  // input ("8000" vs "20000") previously hit the comparison first, which
  // compares lexicographically — "20000" < "8000" is true — and threw a
  // misleading "max must be >= min" error for what was actually a type
  // problem.
  for (const key of NUMERIC_KEYS) {
    if (!Number.isFinite(next[key])) {
      throw new Error(`${key} must be a number`);
    }
  }
  if (next.sendBatchSize < 1) {
    // 0 previously passed a ">= 0" check, then `attempts % 0` is NaN in the
    // send loop, so `=== 0` was never true and the long batch pause simply
    // never fired — no error, no warning, just silently faster sending.
    throw new Error("Batch size must be at least 1");
  }
  for (const key of NUMERIC_KEYS) {
    if (key === "sendBatchSize") continue;
    if (next[key] < 0) throw new Error(`${key} must be a non-negative number`);
  }
  if (next.sendMaxDelayMs < next.sendMinDelayMs) {
    throw new Error("Max delay must be >= min delay");
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

  // Both optional (empty string is valid — "no poster/brochure configured
  // for this event"), but if something IS provided it must at least be a
  // well-formed URL, so a typo doesn't sit unnoticed until preflight fails
  // every single recipient.
  for (const key of ["posterLink", "brochureLink"]) {
    const val = String(next[key] ?? "").trim();
    if (val) {
      try {
        new URL(val);
      } catch {
        throw new Error(`${key === "posterLink" ? "Poster" : "Brochure"} link is not a valid URL`);
      }
    }
    next[key] = val;
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

module.exports = { getSettings, saveSettings, seedTemplateIfMissing };
