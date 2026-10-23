const crypto = require("crypto");
const db = require("./pool");

// Every export below keeps the exact name, arguments, and async shape the
// Postgres version had — a synchronous SQLite call inside an async function
// still returns a Promise, so server.js and wa/sender.js needed ZERO
// changes for this migration.

function rowToCamel(r) {
  return {
    id: r.id,
    sno: r.sno,
    name: r.name,
    phone: r.phone,
    state: r.state,
    error: r.error,
    sentAt: r.sent_at,
    portfolio: r.portfolio,
    committee: r.committee,
    eventName: r.event_name,
    hostSchoolName: r.host_school_name,
    date: r.date,
    venue: r.venue,
  };
}

// Creates the campaign row and inserts its recipients in ONE transaction.
// Previously these were two independent operations — a failure partway
// through insertRecipients (e.g. a duplicate sno violating
// UNIQUE(campaign_id, sno)) left an orphaned "draft" campaign with zero
// recipients behind. SQLite RETURNING support varies by build; generating
// the id in JS and inserting it explicitly sidesteps that dependency
// entirely.
async function createCampaignWithRecipients({ senderPhone, fileName, rows }) {
  const id = crypto.randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO campaigns (id, sender_phone, file_name, status, created_at) VALUES (?, ?, ?, 'draft', ?)`
    ).run(id, senderPhone, fileName, Date.now());

    if (rows.length > 0) {
      const insert = db.prepare(
        `INSERT INTO recipients
           (campaign_id, sno, name, phone, state, error,
            portfolio, committee, event_name, host_school_name, date, venue)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of rows) {
        insert.run(
          id,
          r.sno,
          r.name,
          r.phone,
          r.state || "pending",
          r.error || null,
          r.portfolio || null,
          r.committee || null,
          r.eventName || null,
          r.hostSchoolName || null,
          r.date || null,
          r.venue || null
        );
      }
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
  return id;
}

async function getCampaign(id) {
  const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    senderPhone: row.sender_phone,
    fileName: row.file_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function setCampaignStatus(id, status) {
  db.prepare("UPDATE campaigns SET status = ? WHERE id = ?").run(status, id);
}

async function listRecipients(campaignId) {
  const rows = db.prepare("SELECT * FROM recipients WHERE campaign_id = ? ORDER BY sno ASC").all(campaignId);
  return rows.map(rowToCamel);
}

async function getRecipientsBySnos(campaignId, snos) {
  if (snos.length === 0) return [];
  const placeholders = snos.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM recipients WHERE campaign_id = ? AND sno IN (${placeholders}) ORDER BY sno ASC`)
    .all(campaignId, ...snos);
  return rows.map(rowToCamel);
}

async function updateRecipientResult(campaignId, sno, { state, error, sentAt }) {
  db.prepare(
    `UPDATE recipients SET state = ?, error = ?, sent_at = ? WHERE campaign_id = ? AND sno = ?`
  ).run(state, error ?? null, sentAt ? sentAt.getTime() : null, campaignId, sno);
}

// How many messages this sender has actually submitted, across ALL
// campaigns, in the trailing window: 24h by default, for the daily cap.
// wa/sender.js's hourly cap uses msUntilHourlySlot below instead. The cutoff
// is plain epoch-ms computed in JS.
async function countRecentSends(senderPhone, windowMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.sender_phone = ? AND r.state = 'submitted' AND r.sent_at > ?`
    )
    .get(senderPhone, cutoff);
  return row.c;
}

// Hourly cap (v1.6.0 pacing profiles): returns 0 if another send fits in
// the trailing hour right now, otherwise how many ms until the oldest send
// that's in the way ages out of it (+1s of margin).
async function msUntilHourlySlot(senderPhone, hourlyCap) {
  const windowMs = 60 * 60 * 1000;
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT r.sent_at AS t FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.sender_phone = ? AND r.state = 'submitted' AND r.sent_at > ?
       ORDER BY r.sent_at ASC`
    )
    .all(senderPhone, now - windowMs);
  if (rows.length < hourlyCap) return 0;
  const blocking = rows[rows.length - hourlyCap];
  return Math.max(0, blocking.t + windowMs - now) + 1000;
}

// "Start over" cleanup. Scoped to THIS sender only. `recipients` cascades
// via its FK to campaigns (db/schema.js, PRAGMA foreign_keys = ON in pool.js).
async function purgeCampaignsForSender(senderPhone) {
  db.prepare("DELETE FROM campaigns WHERE sender_phone = ?").run(senderPhone);
}

module.exports = {
  createCampaignWithRecipients,
  getCampaign,
  setCampaignStatus,
  listRecipients,
  getRecipientsBySnos,
  updateRecipientResult,
  countRecentSends,
  msUntilHourlySlot,
  purgeCampaignsForSender,
};
