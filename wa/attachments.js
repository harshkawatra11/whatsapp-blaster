// The poster is sent as a real attached image. Downloads and caches it from
// a public Google Drive share link.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.WABLASTER_DB_PATH
  ? path.dirname(process.env.WABLASTER_DB_PATH)
  : path.join(__dirname, "..", "data");
const CACHE_DIR = path.join(DATA_DIR, "campaign-assets");
const MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's own attachment size limit
const DOWNLOAD_TIMEOUT_MS = 30000;
const EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
const memoryCache = new Map();

// Handles every share-link shape Drive actually produces:
//   https://drive.google.com/file/d/<id>/view?usp=sharing
//   https://drive.google.com/open?id=<id>
//   https://drive.google.com/uc?id=<id>&export=download
function extractDriveFileId(url) {
  if (!url) return null;
  const s = String(url);
  const fileMatch = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const idMatch = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  return null;
}

// Returns { ok: true, path } or { ok: false, error }. Never throws.
//
// Downloads fresh EVERY run — no permanent disk cache keyed by file ID
// (removed; there used to be one). With one poster per run now
// (effectivePoster() in wa/sender.js — no more per-recipient CSV overrides),
// re-downloading once per campaign is cheap, and it guarantees the bytes
// sent are always current: a permanent cache meant replacing the file at
// the same Drive link (keeping the link, swapping the image) silently kept
// sending the OLD bytes forever, which was part of what made a stale
// poster look "hardwired into the app." memoryCache still dedupes repeat
// calls within a single run (e.g. preflight + a retry).
async function downloadDriveFile(url) {
  const fileId = extractDriveFileId(url);
  if (!fileId) return { ok: false, error: `not a recognisable Google Drive link: "${url}"` };
  if (memoryCache.has(fileId)) return memoryCache.get(fileId);

  let result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      result = { ok: false, error: `Drive returned HTTP ${res.status} — check the file is shared as "Anyone with the link"` };
    } else {
      const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!contentType.startsWith("image/")) {
        result = { ok: false, error: `link did not return an image (got "${contentType || "no content-type"}")` };
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) {
          result = { ok: false, error: "downloaded file was empty" };
        } else if (buf.length > MAX_BYTES) {
          result = { ok: false, error: `image is ${(buf.length / 1024 / 1024).toFixed(1)}MB — WhatsApp's own limit is 16MB` };
        } else {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          const filePath = path.join(CACHE_DIR, `${fileId}${EXT_BY_MIME[contentType] || ".jpg"}`);
          fs.writeFileSync(filePath, buf);
          result = { ok: true, path: filePath };
        }
      }
    }
  } catch (e) {
    result = { ok: false, error: e.name === "AbortError" ? "download timed out" : e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
  memoryCache.set(fileId, result);
  return result;
}

function clearMemoryCache() {
  memoryCache.clear();
}

// A directly-uploaded poster, as an alternative to a Drive link. Single
// slot deliberately — one active local poster at a time, so there's never
// more than one file on disk and nothing to garbage collect. Separate
// directory from CACHE_DIR: Drive downloads are addressed by file ID and
// safe to accumulate/reuse across links, but an upload has no such stable
// identity (a re-upload of "the same" file has no id to key on), so it's
// simplest as one always-overwritten slot instead.
const LOCAL_POSTER_DIR = path.join(DATA_DIR, "local-poster");

// Resolves the stored filename (as saved in settings.posterUploadFilename)
// to an absolute path, confirming the file still exists on disk. Returns
// null when no filename is given (nothing configured — not an error);
// { ok:false, error } when a filename IS configured but the file is
// missing (deleted by hand, moved userData, etc) — same shape
// downloadDriveFile's failure returns, so callers can treat both
// poster sources identically.
function resolveLocalPoster(filename) {
  if (!filename) return null;
  const p = path.join(LOCAL_POSTER_DIR, filename);
  return fs.existsSync(p) ? { ok: true, path: p } : { ok: false, error: "uploaded poster file is missing on disk" };
}

// Validates and saves an uploaded poster buffer, replacing any previous
// upload. Reuses the same MAX_BYTES/EXT_BY_MIME rules as a Drive download,
// so a local upload can't silently exceed WhatsApp's own 16MB limit or
// arrive as a non-image. Returns { ok:true, filename } or { ok:false, error }.
function saveLocalPoster(buffer, mimeType) {
  if (!buffer || buffer.length === 0) return { ok: false, error: "uploaded file was empty" };
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: `image is ${(buffer.length / 1024 / 1024).toFixed(1)}MB — WhatsApp's own limit is 16MB` };
  }
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) return { ok: false, error: `unsupported image type "${mimeType}" — use JPEG, PNG, GIF, or WebP` };

  fs.mkdirSync(LOCAL_POSTER_DIR, { recursive: true });
  // Clear out any previous upload first (possibly a different extension)
  // so the single-slot guarantee holds even across a JPEG-then-PNG
  // sequence of uploads.
  for (const f of fs.readdirSync(LOCAL_POSTER_DIR)) {
    fs.unlinkSync(path.join(LOCAL_POSTER_DIR, f));
  }
  const filename = `local-poster${ext}`;
  fs.writeFileSync(path.join(LOCAL_POSTER_DIR, filename), buffer);
  return { ok: true, filename };
}

// Best-effort delete — used both by "Remove upload" and by Start over.
// Never throws: a file already gone (or never existing) isn't a failure
// from the caller's point of view, since the end state (no local poster on
// disk) is the same either way.
function deleteLocalPoster(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(LOCAL_POSTER_DIR, filename));
  } catch {
    /* already gone */
  }
}

module.exports = {
  downloadDriveFile,
  clearMemoryCache,
  resolveLocalPoster,
  saveLocalPoster,
  deleteLocalPoster,
};
