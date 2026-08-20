// The message is now user-editable from the app's Settings/Template panel
// and stored in the `settings` table (db/settings.js) — NOT here. This file
// only holds the built-in default (used to seed the DB on first run, and as
// the "Reset to default" target) and the fill logic. A packaged app's files
// are inside a read-only asar, so a template that had to be edited by
// changing this file would be unreachable for a non-technical teammate —
// the same reason pacing settings were moved out of .env earlier.
//
// The default is text-only — an optional poster image can be configured
// separately (Settings — a Drive link or a direct upload, the only source;
// there is no per-row CSV override) and is attached by wa/sender.js, not
// part of this template text. See the decision log (docs/decisions.md) for
// why a poster image was dropped and later reinstated on a different
// mechanism than originally planned.
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

function buildMessageText(row, templateText, nameFallback) {
  const text = templateText || DEFAULT_TEMPLATE;
  return fillTemplate(text, row, nameFallback || DEFAULT_NAME_FALLBACK);
}

module.exports = { buildMessageText, DEFAULT_TEMPLATE, DEFAULT_NAME_FALLBACK };
