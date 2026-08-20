const NAME_ALIASES = ["name", "full name", "participant", "student", "participant name"];
const PHONE_ALIASES = ["phone", "mobile", "number", "contact", "whatsapp", "phone number", "mobile number"];
// Deliberately no per-row poster column support — removed after a real
// incident: a stale POSTER LINK column in an event's CSV silently
// overrode the poster set on the starter screen, per row, with no
// indication in the UI, so an uploaded image never actually got sent. The
// poster now comes from exactly one place (Settings) — see
// wa/sender.js's effectivePoster() and docs/decisions.md.

// Minimal RFC-4180 parser: quoted fields, embedded commas/newlines, CRLF or
// LF line endings, doubled-quote escaping. No dependency needed for this.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // swallowed; the following \n (or end of field) ends the row
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // last field/row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop fully blank trailing lines
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function findColumn(headers, aliases) {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  for (let i = 0; i < normalized.length; i++) {
    if (aliases.some((alias) => normalized[i].includes(alias))) return i;
  }
  return -1;
}

function normalizePhone(raw, defaultCountry) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  digits = digits.replace(/^0+/, "");
  if (digits.length === 0) return null;
  if (digits.length === 10) digits = `${defaultCountry}${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

// Parses the CSV and normalises phones, but never renumbers or drops rows —
// S.No. must always mean "line N of the operator's own file", since that's
// the only handle the Select-step UI gives them. Duplicates and unparseable
// numbers are kept as `skipped` rows with a reason, not removed.
function buildAudience(csvText, defaultCountry) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new Error("CSV appears to be empty");

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const nameIdx = findColumn(headers, NAME_ALIASES);
  const phoneIdx = findColumn(headers, PHONE_ALIASES);
  if (nameIdx === -1 || phoneIdx === -1) {
    throw new Error(
      `Could not find name/phone columns. Headers found: ${headers.join(", ") || "(none)"}`
    );
  }
  const seen = new Set();
  return dataRows.map((cells, i) => {
    const sno = i + 1;
    const name = (cells[nameIdx] || "").trim();
    const rawPhone = cells[phoneIdx] || "";
    const phone = normalizePhone(rawPhone, defaultCountry);

    if (!phone) {
      return { sno, name, phone: null, state: "skipped", error: "invalid phone number" };
    }
    if (seen.has(phone)) {
      return { sno, name, phone, state: "skipped", error: "duplicate phone number in this file" };
    }
    seen.add(phone);
    return { sno, name, phone, state: "pending", error: null };
  });
}

module.exports = { buildAudience };
