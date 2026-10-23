// The message is user-editable from Step 1's Message Template editor and is
// stored in the `settings` table (db/settings.js), NOT here. This file only
// holds the built-in default (used to seed the DB on first run, and as the
// "Reset to default" target) and the fill logic. A packaged app's files are
// inside a read-only asar, so a template that had to be edited by changing
// this file would be unreachable for a non-technical teammate.
//
// The default is text-only — an optional poster image can be configured
// separately (Step 1's Poster section: a Drive link or a direct upload, the
// only source; there is no per-row CSV override) and is attached by
// wa/sender.js, not part of this template text. See the decision log
// (docs/decisions.md) for why a poster image was dropped and later
// reinstated on a different mechanism than originally planned.
const DEFAULT_TEMPLATE = `Hi {{name}},

You're invited to our upcoming event! We're excited to have you join us as a participant.

Please keep an eye on this chat for further event details, and reply here if you have any questions.

Thanks!`;

const DEFAULT_NAME_FALLBACK = "there";

function fillTemplate(text, row, nameFallback) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    let value = row[key];
    // A blank CSV name cell previously left the literal "{{name}}" in a real
    // send ("Hi {{name}},") — substitute the configured fallback instead,
    // but only for `name`; an unknown/blank placeholder for any other field
    // still passes through untouched, which is a template-authoring signal
    // worth leaving visible.
    if ((value === undefined || value === null || value === "") && key === "name") {
      value = nameFallback || DEFAULT_NAME_FALLBACK;
    }
    if (value === undefined || value === null || value === "") return match;
    return String(value);
  });
}

// Opening-greeting variation (v1.6.0). Byte-identical text sent to many new
// contacts is a classic bulk-spam signature, so when a message opens with
// "Hi" or "Hello" that one word is swapped at random between the two, per
// recipient. Deliberately nothing else changes (operator request: "keep hi
// and hello only"). The (?![a-z]) lookahead stops "History..." or
// "Hillary..." from matching.
const GREETING_RE = /^(\s*)(hi|hello)(?![a-z])/i;

function matchCase(word, model) {
  if (model.length > 1 && model === model.toUpperCase()) return word.toUpperCase();
  if (model[0] === model[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function varyGreeting(text, rand = Math.random) {
  const m = String(text).match(GREETING_RE);
  if (!m) return text;
  const pick = rand() < 0.5 ? "hi" : "hello";
  return m[1] + matchCase(pick, m[2]) + text.slice(m[0].length);
}

// options.varyGreeting is opt-in so the preview, tests and any other caller
// stay deterministic; only wa/sender.js turns it on for real runs.
function buildMessageText(row, templateText, nameFallback, options = {}) {
  const text = templateText || DEFAULT_TEMPLATE;
  const filled = fillTemplate(text, row, nameFallback || DEFAULT_NAME_FALLBACK);
  return options.varyGreeting ? varyGreeting(filled, options.rand) : filled;
}

module.exports = { buildMessageText, varyGreeting, DEFAULT_TEMPLATE, DEFAULT_NAME_FALLBACK };
