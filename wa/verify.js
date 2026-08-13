// Composer-verification oracle, shared by wa/desktop.win.js and
// wa/desktop.mac.js. Platform-independent: both backends paste a sentinel,
// select-all + copy from whatever holds focus, then score what came back
// against the expected text. See either backend's verifyComposer() for the
// platform-specific keystrokes; the scoring logic itself never changes.

// Windows text controls round-trip line breaks as CRLF regardless of what
// was pasted in. The template is authored with bare LF, so an exact string
// compare between the pasted text and what gets copied back ALWAYS fails on
// any multi-line message — this is what silently broke every real send
// while passing the single-line test that first validated this function.
function normaliseLineEndings(s) {
  return String(s).replace(/\r\n?/g, "\n").trim();
}

// WhatsApp's composer applies its own rich-text autoformatting as text lands
// in it — e.g. "- " at the start of a line becomes a bullet "* ". That is a
// REAL, intentional change to the composer's content, not a copy/paste
// artifact, so exact equality is the wrong bar even after line-ending
// normalisation (diagnosed by dumping a real capture: a template line
// starting "- " came back starting "* ", one character different).
// A same-length, mostly-matching string is exactly what a legitimate paste
// looks like; empty, truncated, or unrelated content is what a genuine
// failure looks like. Position-wise similarity on same-length text — or
// automatic failure on a large length gap — distinguishes the two without
// hand-listing every markdown-ish pattern WhatsApp might rewrite.
function similarity(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  let matches = minLen - maxLen; // length gap counts against the score (0 when lengths are equal)
  for (let i = 0; i < minLen; i++) if (a[i] === b[i]) matches++;
  return Math.max(0, matches) / maxLen;
}

const VERIFY_SIMILARITY_THRESHOLD = 0.95;

module.exports = { normaliseLineEndings, similarity, VERIFY_SIMILARITY_THRESHOLD };
