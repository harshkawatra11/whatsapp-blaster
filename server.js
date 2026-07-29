const path = require("path");
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

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Per-campaign abort flags. In-memory and single-process is the right
// amount of machinery for a single-operator tool with one send running
// at a time — no job queue or external store needed for this.
const activeAborts = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Health --------------------------------------------------------------

app.get("/healthz", (req, res) => res.json({ ok: true }));

// --- Settings ------------------------------------------------------------
// Pacing, daily cap, and default country — editable here rather than via
// .env, since a packaged app's working directory is inside a read-only
// install and .env would be unreachable for a teammate who needs to tune it.

app.get("/api/settings", async (req, res) => {
  try {
    res.json(await settingsDb.getSettings());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    res.json(await settingsDb.saveSettings(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Sender number -----------------------------------------------------
// WhatsApp Desktop owns its own login — there is no pairing/QR flow here.
// This just records which phone number the operator is sending from, used
// to scope the daily cap.

app.get("/api/numbers", async (req, res) => {
  try {
    const rows = await sessions.listNumbers();
    const running = await desktop.isRunning();
    res.json(rows.map((r) => ({ ...r, status: running ? "ready" : "app_not_running" })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/numbers", async (req, res) => {
  try {
    const phoneNumber = req.body?.phoneNumber;
    if (!phoneNumber) return res.status(400).json({ error: "phoneNumber is required" });
    const id = sessions.slugify(phoneNumber);
    if (!id) return res.status(400).json({ error: "phoneNumber has no digits" });

    const running = await desktop.isRunning();
    await sessions.upsertSession({
      id,
      phoneNumber: id,
      displayName: req.body?.displayName || phoneNumber,
      status: running ? "ready" : "app_not_running",
    });
    res.json({ id, appRunning: running });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/numbers/:id", async (req, res) => {
  try {
    await sessions.deleteNumber(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

    const campaignId = await campaigns.createCampaign({
      senderPhone: senderId,
      fileName: req.file.originalname,
    });
    await campaigns.insertRecipients(campaignId, rows);

    const summary = { pending: 0, skipped: 0 };
    for (const r of rows) summary[r.state] = (summary[r.state] || 0) + 1;

    res.json({ campaignId, total: rows.length, summary });
  } catch (e) {
    console.error("POST /api/campaigns failed:", e);
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/campaigns/:id", async (req, res) => {
  const campaign = await campaigns.getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Unknown campaign" });
  const recipients = await campaigns.listRecipients(req.params.id);
  res.json({ campaign, recipients });
});

// "Start over": clears campaign history for ONE sender.
app.delete("/api/campaigns", async (req, res) => {
  try {
    const senderId = req.query.senderId;
    if (!senderId) return res.status(400).json({ error: "senderId is required" });
    await campaigns.purgeCampaignsForSender(senderId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/campaigns/:id/send", async (req, res) => {
  const campaignId = req.params.id;
  try {
    const campaign = await campaigns.getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: "Unknown campaign" });

    const snos = Array.isArray(req.body?.snos) ? req.body.snos : [];
    if (snos.length === 0) return res.status(400).json({ error: "snos must be a non-empty array" });

    const recipients = await campaigns.getRecipientsBySnos(campaignId, snos);

    res.set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
    res.flushHeaders();

    activeAborts.set(campaignId, false);
    await campaigns.setCampaignStatus(campaignId, "running");

    await sender.runCampaign({
      senderId: campaign.senderPhone,
      campaignId,
      recipients,
      onEvent: (evt) => res.write(JSON.stringify(evt) + "\n"),
      isAborted: () => activeAborts.get(campaignId) === true,
    });

    const finalStatus = activeAborts.get(campaignId) ? "aborted" : "done";
    await campaigns.setCampaignStatus(campaignId, finalStatus);
    activeAborts.delete(campaignId);
    res.end();
  } catch (e) {
    console.error(`POST /api/campaigns/${campaignId}/send failed:`, e);
    try {
      res.write(JSON.stringify({ type: "error", error: e.message }) + "\n");
    } catch (_) {}
    try {
      await campaigns.setCampaignStatus(campaignId, "aborted");
    } catch (_) {}
    activeAborts.delete(campaignId);
    res.end();
  }
});

app.post("/api/campaigns/:id/abort", (req, res) => {
  activeAborts.set(req.params.id, true);
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
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

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

module.exports = { app, startServer };
