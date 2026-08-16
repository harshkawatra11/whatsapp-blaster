// The poster is sent as a real attached image; the brochure stays a plain
// link (it's a document, not an image). Downloads and caches the poster
// from a public Google Drive share link, and does a cheap reachability
// check for the brochure preflight warning.

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
const shortenCache = new Map();

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

// A cheap reachability check — used at preflight to WARN (never block; a
// dead link must not stop the rest of the message from sending). Verified
// live against a real deleted-file Drive link: a clean 404 to a HEAD
// request, no false positive.
async function checkLinkReachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timed out" : e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function findCachedFile(fileId) {
  if (!fs.existsSync(CACHE_DIR)) return null;
  const hit = fs.readdirSync(CACHE_DIR).find((f) => f.startsWith(`${fileId}.`));
  return hit ? path.join(CACHE_DIR, hit) : null;
}

// Returns { ok: true, path } or { ok: false, error }. Never throws.
async function downloadDriveFile(url) {
  const fileId = extractDriveFileId(url);
  if (!fileId) return { ok: false, error: `not a recognisable Google Drive link: "${url}"` };
  if (memoryCache.has(fileId)) return memoryCache.get(fileId);

  const cached = findCachedFile(fileId);
  if (cached) {
    const result = { ok: true, path: cached };
    memoryCache.set(fileId, result);
    return result;
  }

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

// Shortens a brochure link via TinyURL's key-less create endpoint — no
// account, no auth. Never blocks a send: any failure (network, non-URL
// response) falls back to the original link in `.url`, so a caller can
// always just use `result.url` regardless of `.ok`.
async function shortenUrl(url) {
  if (shortenCache.has(url)) return shortenCache.get(url);

  let result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
    });
    if (res.ok) {
      const short = (await res.text()).trim();
      result = short.startsWith("http")
        ? { ok: true, url: short }
        : { ok: false, url, error: `unexpected response: ${short.slice(0, 80)}` };
    } else {
      result = { ok: false, url, error: `HTTP ${res.status}` };
    }
  } catch (e) {
    result = { ok: false, url, error: e.name === "AbortError" ? "timed out" : e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
  shortenCache.set(url, result);
  return result;
}

function clearMemoryCache() {
  memoryCache.clear();
  shortenCache.clear();
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
  checkLinkReachable,
  downloadDriveFile,
  shortenUrl,
  clearMemoryCache,
  resolveLocalPoster,
  saveLocalPoster,
  deleteLocalPoster,
};
