// This is a single-campaign internal tool for one event, not a multi-template
// product — the message is intentionally hardcoded here rather than made
// configurable through the UI or database.
//
// Text only. Sending happens by driving WhatsApp Web's real UI, where
// attaching an image means scripting the file picker and its preview dialog;
// that is a materially more fragile flow and this campaign does not need it.
const TEMPLATE = {
  // No leading "- " on its own line anywhere in here: WhatsApp Desktop's
  // composer auto-converts "- " at the start of a line into a bullet "* "
  // as you type/paste (its own rich-text autoformatting). That silently
  // changed the actual composer content vs what was pasted and made every
  // send fail composer verification — diagnosed by dumping verifyComposer's
  // raw capture and diffing it against the source text character-by-character.
  text: `Hi {{name}},

You're invited to Rajdhani Yuva Sansad (MUN)! We're excited to have you join us as a participant.

Please keep an eye on this chat for further event details, and reply here if you have any questions.

Team RYS`,
};

function fillTemplate(text, row) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (row[key] === undefined || row[key] === null || row[key] === "") return match;
    return String(row[key]);
  });
}

function buildMessageText(row) {
  return fillTemplate(TEMPLATE.text, row);
}

module.exports = { buildMessageText };
