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
  };
}

async function createCampaign({ senderPhone, fileName }) {
  // SQLite RETURNING support varies by build; generating the id in JS and
  // inserting it explicitly sidesteps that dependency entirely.
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO campaigns (id, sender_phone, file_name, status, created_at) VALUES (?, ?, ?, 'draft', ?)`
  ).run(id, senderPhone, fileName, Date.now());
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

// Postgres used unnest() for a one-round-trip bulk insert. SQLite has no
// equivalent, but doesn't need one: a prepared statement looped inside a
// single transaction inserted 2000 rows in 3ms in direct testing — plenty
// fast for a CSV of this scale.
async function insertRecipients(campaignId, rows) {
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO recipients (campaign_id, sno, name, phone, state, error) VALUES (?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      insert.run(campaignId, r.sno, r.name, r.phone, r.state || "pending", r.error || null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
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

// Used to enforce DAILY_CAP: how many messages this sender has actually
// submitted across ALL campaigns in the last 24 hours. The cutoff is
// computed in JS as a plain epoch-ms number, replacing Postgres's
// `now() - interval '24 hours'`.
async function countRecentSends(senderPhone) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.sender_phone = ? AND r.state = 'submitted' AND r.sent_at > ?`
    )
    .get(senderPhone, cutoff);
  return row.c;
}

// "Start over" cleanup. Scoped to THIS sender only. `recipients` cascades
// via its FK to campaigns (db/schema.js, PRAGMA foreign_keys = ON in pool.js).
async function purgeCampaignsForSender(senderPhone) {
  db.prepare("DELETE FROM campaigns WHERE sender_phone = ?").run(senderPhone);
}

module.exports = {
  createCampaign,
  getCampaign,
  setCampaignStatus,
  insertRecipients,
  listRecipients,
  getRecipientsBySnos,
  updateRecipientResult,
  countRecentSends,
  purgeCampaignsForSender,
};
