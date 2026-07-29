const db = require("./pool");

function toCamel(row) {
  if (!row) return null;
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slugify(phoneDigits) {
  return String(phoneDigits).replace(/\D/g, "");
}

async function listNumbers() {
  const rows = db
    .prepare("SELECT id, phone_number, display_name, status, created_at, updated_at FROM wa_sessions ORDER BY created_at ASC")
    .all();
  return rows.map(toCamel);
}

async function getNumber(id) {
  const row = db.prepare("SELECT * FROM wa_sessions WHERE id = ?").get(id);
  return toCamel(row);
}

async function upsertSession({ id, phoneNumber, displayName, status }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO wa_sessions (id, phone_number, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       phone_number = excluded.phone_number,
       display_name = excluded.display_name,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(id, phoneNumber, displayName, status, now, now);
}

async function deleteNumber(id) {
  db.prepare("DELETE FROM wa_sessions WHERE id = ?").run(id);
}

module.exports = {
  slugify,
  listNumbers,
  getNumber,
  upsertSession,
  deleteNumber,
};
