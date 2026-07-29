require("dotenv").config();

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for env var ${name}: "${raw}"`);
  return n;
}

// Everything that's actually tunable by the operator (pacing, daily cap,
// default country) lives in the settings table (db/settings.js), editable
// from the app's Settings panel — not here. A packaged app's working
// directory is inside a read-only install (or absent), so .env is not a
// place a non-technical teammate could ever reach to change a limit.
//
// This file only holds things that are genuinely fixed per install: the
// port the local server listens on, and the database file path.
module.exports = {
  // 3000 for standalone/dev use (predictable, matches local testing). The
  // Electron wrapper (Part C) overrides this to 0 (OS-assigned free port)
  // before requiring this module, then discovers the actual port from the
  // running server — avoids colliding with anything already on 3000 on a
  // machine we don't control.
  port: int("PORT", 3000),
};
