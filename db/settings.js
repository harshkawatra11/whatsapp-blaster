const db = require("./pool");

// User-tunable send settings, editable from the app's Settings panel. This
// replaces .env-only pacing config — a packaged app's working directory is
// inside a read-only install (or absent), so .env is unreachable there.
// Deliberately no hard ceiling on any of these, per the original product
// requirement ("sensible defaults shown in the UI, every limit editable").
const DEFAULTS = {
  sendMinDelayMs: 8000,
  sendMaxDelayMs: 20000,
  sendBatchSize: 50,
  dailyCap: 200,
  defaultCountry: "91",
};

const NUMERIC_KEYS = new Set(["sendMinDelayMs", "sendMaxDelayMs", "sendBatchSize", "dailyCap"]);

async function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = { ...DEFAULTS, ...stored };
  for (const key of NUMERIC_KEYS) merged[key] = Number(merged[key]);
  return merged;
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };

  if (next.sendMaxDelayMs < next.sendMinDelayMs) {
    throw new Error("Max delay must be >= min delay");
  }
  for (const key of NUMERIC_KEYS) {
    if (!Number.isFinite(next[key]) || next[key] < 0) {
      throw new Error(`${key} must be a non-negative number`);
    }
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
    db.exec("ROLLBACK");
    throw e;
  }
  return next;
}

module.exports = { getSettings, saveSettings, DEFAULTS };
