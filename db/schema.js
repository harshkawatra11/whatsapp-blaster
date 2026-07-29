const db = require("./pool");

// The WhatsApp login itself is NOT stored here — WhatsApp Desktop owns its
// own session. This table only records which sender number is configured.
//
// Timestamps are INTEGER epoch-milliseconds (Date.now() computed in JS),
// not SQL defaults — every timestamp is a plain number, which sidesteps
// SQLite's text-based date functions entirely and makes "last 24 hours"
// filters a trivial numeric comparison.
const DDL = `
CREATE TABLE IF NOT EXISTS wa_sessions (
  id TEXT PRIMARY KEY,
  phone_number TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  sender_phone TEXT,
  file_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sno INTEGER NOT NULL,
  name TEXT,
  phone TEXT,
  -- pending | submitted | unknown | skipped. WhatsApp Desktop exposes no
  -- readable UI, so a send cannot be confirmed delivered — 'submitted' means
  -- only that the paste+Enter sequence completed, never that it arrived.
  state TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  sent_at INTEGER,
  UNIQUE(campaign_id, sno)
);

CREATE INDEX IF NOT EXISTS recipients_campaign_state_idx ON recipients(campaign_id, state);

-- User-tunable send settings (pacing, daily cap, etc). Editable from the
-- app's Settings panel — not .env, since a packaged app's working directory
-- is inside a read-only install and .env would be unreachable/unusable.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function ensureSchema() {
  db.exec(DDL);
  console.log("   Schema ready (wa_sessions, campaigns, recipients, settings).");
}

module.exports = { ensureSchema };
