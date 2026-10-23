// Pacing profiles and human-like timing helpers, shared by wa/sender.js
// (gaps between recipients), wa/desktop.*.js (per-keystroke waits) and
// db/settings.js (validating the chosen profile). Lives at the repo root
// like template.js, so db/ never has to depend on wa/.
//
// Replaces the free-form min/max delay, batch size and daily cap settings
// (v1.6.0). Those had been set to 0/0 for speed, which made every run one
// fixed back-to-back rhythm, the most bot-like pattern this app could
// produce. Operators now pick one of three named profiles instead, and every
// wait inside a profile is randomised.

const PACING_PROFILES = {
  cautious: {
    label: "Cautious",
    description: "Safest. Use for a new number or a list of people who have never messaged you.",
    gapMs: [45000, 120000],
    breakEvery: [6, 10],
    breakMs: [300000, 900000],
    dailyCap: 100,
    hourlyCap: 25,
  },
  balanced: {
    label: "Balanced",
    description: "Recommended for most campaigns.",
    gapMs: [20000, 60000],
    breakEvery: [8, 15],
    breakMs: [180000, 480000],
    dailyCap: 150,
    hourlyCap: 40,
  },
  fast: {
    label: "Fast",
    description: "Closest to the old speed. Least protection for the sending number.",
    gapMs: [8000, 25000],
    breakEvery: [15, 25],
    breakMs: [120000, 240000],
    dailyCap: 200,
    hourlyCap: null,
  },
};

const DEFAULT_PACING_PROFILE = "balanced";

// Object.hasOwn, not `key in` / truthiness: PACING_PROFILES is a plain object
// literal, so PACING_PROFILES["toString"] is truthy and would otherwise pass
// validation as a "profile".
function isProfileKey(key) {
  return typeof key === "string" && Object.hasOwn(PACING_PROFILES, key);
}

function resolveProfile(key) {
  return PACING_PROFILES[isProfileKey(key) ? key : DEFAULT_PACING_PROFILE];
}

// Uniform integer in [min, max].
function randomBetween(min, max, rand = Math.random) {
  return min + Math.floor(rand() * (max - min + 1));
}

// Mean of two uniform draws: still bounded by [min, max], but clusters toward
// the middle, so gaps don't spread flat across the range the way a single
// uniform draw does.
function humanGap([min, max], rand = Math.random) {
  return Math.round((randomBetween(min, max, rand) + randomBetween(min, max, rand)) / 2);
}

// Stretches a tuned wait by 0-40%, never shortens it. Every Start-Sleep /
// delay in wa/desktop.*.js was tuned as the minimum WhatsApp needs to settle,
// so jitter only ever adds time. It exists so no two sends share an identical
// keystroke rhythm.
function jitter(ms, spread = 0.4, rand = Math.random) {
  return Math.round(ms * (1 + rand() * spread));
}

// Per-character delays (ms) for typing `text`, one entry per character:
// 45-140ms each, plus a 150-450ms "thinking" pause after roughly a third of
// spaces and commas.
function typingDelays(text, rand = Math.random) {
  return Array.from(String(text)).map((ch) => {
    let ms = randomBetween(45, 140, rand);
    if ((ch === " " || ch === ",") && rand() < 0.35) ms += randomBetween(150, 450, rand);
    return ms;
  });
}

// Per-digit delays (ms) for typing a phone number: 70-220ms each, and about
// one digit in eight gets an extra 300-600ms hesitation.
function digitDelays(digits, rand = Math.random) {
  return Array.from(String(digits)).map(() => {
    let ms = randomBetween(70, 220, rand);
    if (rand() < 0.125) ms += randomBetween(300, 600, rand);
    return ms;
  });
}

// How long the finished message sits in the composer before Enter, roughly
// "re-reading what you wrote". Scales with length, clamped to 1.2-4.5s, then
// jittered.
function composeDwellMs(textLength, rand = Math.random) {
  const base = Math.min(4500, Math.max(1200, textLength * 15));
  return jitter(base, 0.4, rand);
}

// Pause after a chat opens, before anything is typed: 0.8-2.5s.
function chatOpenPauseMs(rand = Math.random) {
  return randomBetween(800, 2500, rand);
}

// Splits a message for hybrid typing:
//   head       - the first line, typed key by key
//   lineBreaks - how many newlines follow it, typed as Shift+Enter
//   body       - everything after those newlines, pasted
// head is "" (and body is the whole message) when the first line isn't safe
// to type: too long, or containing anything beyond plain ASCII letters,
// digits and , . ! ? ' -. SendKeys / System Events can't reliably type emoji
// or non-Latin script, and ":" opens WhatsApp's emoji picker. Those messages
// are pasted whole, exactly as before v1.6.0.
const TYPEABLE_HEAD = /^[A-Za-z0-9 ,.!?'-]+$/;
const MAX_TYPED_HEAD = 48;

function splitForTyping(text) {
  const s = String(text).replace(/\r\n/g, "\n");
  const nl = s.indexOf("\n");
  const head = nl === -1 ? s : s.slice(0, nl);
  if (!head || head.length > MAX_TYPED_HEAD || !TYPEABLE_HEAD.test(head)) {
    return { head: "", lineBreaks: 0, body: s };
  }
  if (nl === -1) return { head, lineBreaks: 0, body: "" };
  const rest = s.slice(nl);
  const lineBreaks = rest.match(/^\n*/)[0].length;
  return { head, lineBreaks, body: rest.slice(lineBreaks) };
}

module.exports = {
  PACING_PROFILES,
  DEFAULT_PACING_PROFILE,
  MAX_TYPED_HEAD,
  isProfileKey,
  resolveProfile,
  randomBetween,
  humanGap,
  jitter,
  typingDelays,
  digitDelays,
  composeDwellMs,
  chatOpenPauseMs,
  splitForTyping,
};
