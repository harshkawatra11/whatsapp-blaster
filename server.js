const path = require("path");
const { EventEmitter } = require("events");
const express = require("express");
const multer = require("multer");

const config = require("./config");
const { ensureSchema } = require("./db/schema");
const sessions = require("./db/sessions");
const campaigns = require("./db/campaigns");
const settingsDb = require("./db/settings");
const desktop = require("./wa/desktop");
const audience = require("./wa/audience");
const sender = require("./wa/sender");
const { DEFAULT_TEMPLATE, DEFAULT_NAME_FALLBACK } = require("./template");

const app = express();

// A CSV this large (~150k+ rows) gets fully parsed into memory, inserted
// row-by-row, serialized whole into one JSON response, and rendered into one
// innerHTML string on the frontend — the most realistic way to hang the app.
// 20,000 is generous for a real event and well under where any of that
// becomes a problem.
const MAX_CSV_ROWS = 20000;
const MAX_SNOS_PER_SEND = 20000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, parts: 6 },
  fileFilter: (req, file, cb) => {
    if (!/\.csv$/i.test(file.originalname || "")) {
      return cb(new Error("Only .csv files are accepted"));
    }
    cb(null, true);
  },
});

// Per-campaign abort flags, keyed by campaign id. Only ever set for a
// campaign id that has an active run — see the guard in the send route and
// the id check in the abort route below.
const activeAborts = new Map();

// One send at a time: the send loop drives real OS-level state (the
// clipboard, keyboard input, whatever window is foreground). Two concurrent
// runs would interleave keystrokes into the same composer, fight over the
// clipboard save/restore, and each read a fresh (not yet decremented) daily
// cap. This was previously an unenforced assumption in a comment; it's
// enforced here.
let sendingCampaignId = null;

// The Electron main process listens for "send-finished" to re-check for
// updates after a campaign run ends — a natural quiet moment, and one that
// doesn't require the main process to know anything about the send loop's
// internals. A no-op EventEmitter when run standalone (`node server.js`).
const events = new EventEmitter();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Health --------------------------------------------------------------

app.get("/healthz", (req, res) => res.json({ ok: true }));

// --- Settings ------------------------------------------------------------
// Pacing, daily cap, default country, and the message template — editable
// here rather than via .env/a file, since a packaged app's working
// directory is inside a read-only install and neither would be reachable
// for a teammate who needs to tune it.

app.get("/api/settings", async (req, res, next) => {
  try {
    res.json(await settingsDb.getSettings());
  } catch (e) {
    next(e);
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    res.json(await settingsDb.saveSettings(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The built-in default template/fallback — for the editor's "Reset to
// default" action. Served from template.js rather than duplicated as a
// string in the frontend, so the two can never drift apart.
app.get("/api/template/default", (req, res) => {
  res.json({ messageTemplate: DEFAULT_TEMPLATE, nameFallback: DEFAULT_NAME_FALLBACK });
});

// --- Sender number -----------------------------------------------------
// WhatsApp Desktop owns its own login — there is no pairing/QR flow here.
// This just records which phone number the operator is sending from, used
// to scope the daily cap.

app.get("/api/numbers", async (req, res, next) => {
  try {
    const rows = await sessions.listNumbers();
    const running = await desktop.isRunning();
    res.json(rows.map((r) => ({ ...r, status: running ? "ready" : "app_not_running" })));
  } catch (e) {
    next(e);
  }
});

app.post("/api/numbers", async (req, res) => {
  try {
    const phoneNumber = req.body?.phoneNumber;
    if (!phoneNumber) return res.status(400).json({ error: "phoneNumber is required" });
    if (String(phoneNumber).length > 64) return res.status(400).json({ error: "phoneNumber is too long" });
    const id = sessions.slugify(phoneNumber);
    if (!id) return res.status(400).json({ error: "phoneNumber has no digits" });

    const running = await desktop.isRunning();
    await sessions.upsertSession({
      id,
      phoneNumber: id,
      displayName: String(req.body?.displayName || phoneNumber).slice(0, 128),
      status: running ? "ready" : "app_not_running",
    });
    res.json({ id, appRunning: running });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/numbers/:id", async (req, res, next) => {
  try {
    await sessions.deleteNumber(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// --- Campaigns -------------------------------------------------------------

app.post("/api/campaigns", upload.single("file"), async (req, res) => {
  try {
    const senderId = req.body?.senderId;
    if (!senderId) return res.status(400).json({ error: "senderId is required" });
    if (!req.file) return res.status(400).json({ error: "CSV file is required" });

    const senderRow = await sessions.getNumber(senderId);
    if (!senderRow) return res.status(404).json({ error: "Unknown sender" });

    const { defaultCountry } = await settingsDb.getSettings();

    // No cross-campaign dedup here on purpose: CSVs represent different
    // events, and a participant legitimately may need messaging again for a
    // different one. In-file duplicates are still caught by buildAudience().
    const rows = audience.buildAudience(req.file.buffer.toString("utf8"), defaultCountry);

    if (rows.length > MAX_CSV_ROWS) {
      return res.status(400).json({ error: `CSV has ${rows.length} rows — the limit is ${MAX_CSV_ROWS}` });
    }

    // Campaign creation and recipient insert happen in ONE transaction now —
    // previously a mid-insert failure (e.g. a duplicate sno) could leave an
    // orphaned draft campaign with zero recipients behind.
    const campaignId = await campaigns.createCampaignWithRecipients({
      senderPhone: senderId,
      fileName: String(req.file.originalname || "").slice(0, 255),
      rows,
    });

    const summary = { pending: 0, skipped: 0 };
    for (const r of rows) summary[r.state] = (summary[r.state] || 0) + 1;

    res.json({ campaignId, total: rows.length, summary });
  } catch (e) {
    console.error("POST /api/campaigns failed:", e);
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/campaigns/:id", async (req, res, next) => {
  try {
    const campaign = await campaigns.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Unknown campaign" });
    const recipients = await campaigns.listRecipients(req.params.id);
    res.json({ campaign, recipients });
  } catch (e) {
    // Previously unguarded: an async handler's rejection here is NOT caught
    // by Express 4, becomes an unhandled promise rejection, and crashes the
    // whole process under Node's default --unhandled-rejections=throw —
    // reproduced directly against a standalone harness before this fix.
    next(e);
  }
});

// "Start over": clears campaign history for ONE sender.
app.delete("/api/campaigns", async (req, res, next) => {
  try {
    const senderId = req.query.senderId;
    if (!senderId) return res.status(400).json({ error: "senderId is required" });
    await campaigns.purgeCampaignsForSender(senderId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post("/api/campaigns/:id/send", async (req, res) => {
  const campaignId = req.params.id;
  // Hoisted above the try block so the catch handler can also see it — a
  // dry run's exception path must not mark the campaign "aborted" either.
  let dryRun = false;

  if (sendingCampaignId) {
    return res.status(409).json({ error: `A send is already running for campaign ${sendingCampaignId}` });
  }

  try {
    const campaign = await campaigns.getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: "Unknown campaign" });

    const snos = Array.isArray(req.body?.snos) ? req.body.snos : [];
    if (snos.length === 0) return res.status(400).json({ error: "snos must be a non-empty array" });
    if (snos.length > MAX_SNOS_PER_SEND) {
      return res.status(400).json({ error: `Too many rows selected — the limit is ${MAX_SNOS_PER_SEND}` });
    }
    if (!snos.every((n) => Number.isInteger(n))) {
      return res.status(400).json({ error: "snos must contain only integers" });
    }
    // Strict boolean, not just truthy — a typo'd string here must not
    // silently flip a real send into (or out of) a rehearsal.
    if (req.body?.dryRun !== undefined && typeof req.body.dryRun !== "boolean") {
      return res.status(400).json({ error: "dryRun must be a boolean" });
    }
    dryRun = req.body?.dryRun === true;

    const recipients = await campaigns.getRecipientsBySnos(campaignId, snos);

    res.set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
    res.flushHeaders();

    // A rehearsal drives the exact same keyboard/clipboard resource a real
    // send does, so it takes the same exclusive lock — one at a time,
    // dry run or not, never overlapping.
    sendingCampaignId = campaignId;
    activeAborts.set(campaignId, false);
    // A dry run must be indistinguishable from never having run at all,
    // apart from the log stream the operator watches live — the campaign's
    // own persisted status is exactly the kind of real state that must not
    // change.
    if (!dryRun) await campaigns.setCampaignStatus(campaignId, "running");

    // If the browser tab closes mid-run, res.write() would otherwise just
    // silently no-op into a dead socket while the keyboard automation kept
    // driving WhatsApp for the rest of the audience. Treat a client
    // disconnect as an abort request.
    let runFinished = false;
    req.on("close", () => {
      if (!runFinished) activeAborts.set(campaignId, true);
    });

    const result = await sender.runCampaign({
      senderId: campaign.senderPhone,
      campaignId,
      recipients,
      onEvent: (evt) => res.write(JSON.stringify(evt) + "\n"),
      isAborted: () => activeAborts.get(campaignId) === true,
      dryRun,
    });

    // Reflects the run's REAL outcome, not just the operator-abort flag —
    // previously an internal stop (focus failure, 3 consecutive failures)
    // was persisted as "done" because finalStatus only ever looked at
    // activeAborts. Skipped entirely for a dry run — see the "running"
    // guard above.
    if (!dryRun) {
      const operatorAborted = activeAborts.get(campaignId) === true;
      const finalStatus = operatorAborted || result?.stoppedEarly ? "aborted" : "done";
      await campaigns.setCampaignStatus(campaignId, finalStatus);
    }

    runFinished = true;
    activeAborts.delete(campaignId);
    sendingCampaignId = null;
    events.emit("send-finished");
    res.end();
  } catch (e) {
    console.error(`POST /api/campaigns/${campaignId}/send failed:`, e);
    try {
      res.write(JSON.stringify({ type: "error", error: e.message }) + "\n");
    } catch (_) {}
    if (!dryRun) {
      try {
        await campaigns.setCampaignStatus(campaignId, "aborted");
      } catch (_) {}
    }
    activeAborts.delete(campaignId);
    sendingCampaignId = null;
    events.emit("send-finished");
    res.end();
  }
});

app.post("/api/campaigns/:id/abort", (req, res) => {
  const id = req.params.id;
  // Only accept an abort for a campaign that's actually running — otherwise
  // a stray call (bad id, double-click, retry) left a permanent `true` in
  // the map forever, since entries are only ever cleared on the send path.
  // A LATER run of that same campaign id would then find isAborted()
  // already true and skip every recipient without sending anything.
  if (!activeAborts.has(id)) {
    return res.status(404).json({ error: "No active send for this campaign" });
  }
  activeAborts.set(id, true);
  res.json({ ok: true });
});

// --- Boot --------------------------------------------------------------
// Bound to 127.0.0.1 only — this is a local-only tool with no reason to be
// reachable from the LAN. Exported as startServer() (rather than only
// running as a side effect of requiring this file) so the Electron main
// process can require this module directly, start it, and read back
// whatever port was actually bound before pointing a BrowserWindow at it.

function startServer() {
  ensureSchema();
  settingsDb.seedTemplateIfMissing();
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

// Global error handler — MUST be registered last, after every route.
// Without this, a multer error (oversized file, wrong extension) or a
// malformed-JSON body-parser error skipped straight to Express's default
// handler, which returns an HTML error page; the frontend's `await
// res.json()` on that produced a baffling "Unexpected token '<'" instead of
// a readable message. Every error path now returns JSON.
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.message || "Internal error" });
});

if (require.main === module) {
  startServer()
    .then((server) => {
      const { port } = server.address();
      console.log(`RYS WhatsApp Blaster listening on http://127.0.0.1:${port}`);
    })
    .catch((e) => {
      console.error("Fatal startup error:", e);
      process.exit(1);
    });
}

module.exports = { app, startServer, events };
