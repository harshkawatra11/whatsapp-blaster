const test = require("node:test");
const assert = require("node:assert/strict");
const pacing = require("../pacing");

const lo = () => 0;
const hi = () => 0.999999;

test("every profile is internally consistent", () => {
  for (const [key, p] of Object.entries(pacing.PACING_PROFILES)) {
    assert.ok(p.label, key);
    assert.ok(p.gapMs[0] > 0 && p.gapMs[0] < p.gapMs[1], key);
    assert.ok(p.breakEvery[0] >= 1 && p.breakEvery[0] <= p.breakEvery[1], key);
    assert.ok(p.breakMs[0] < p.breakMs[1], key);
    assert.ok(p.dailyCap > 0, key);
    assert.ok(p.hourlyCap === null || p.hourlyCap > 0, key);
  }
  assert.ok(pacing.isProfileKey(pacing.DEFAULT_PACING_PROFILE));
});

test("isProfileKey / resolveProfile reject junk and inherited keys", () => {
  assert.equal(pacing.isProfileKey("toString"), false);
  assert.equal(pacing.isProfileKey(undefined), false);
  assert.equal(pacing.resolveProfile("nope"), pacing.PACING_PROFILES.balanced);
  assert.equal(pacing.resolveProfile("fast"), pacing.PACING_PROFILES.fast);
});

test("humanGap stays inside the range", () => {
  for (const p of Object.values(pacing.PACING_PROFILES)) {
    assert.equal(pacing.humanGap(p.gapMs, lo), p.gapMs[0]);
    assert.equal(pacing.humanGap(p.gapMs, hi), p.gapMs[1]);
    for (let i = 0; i < 200; i++) {
      const g = pacing.humanGap(p.gapMs);
      assert.ok(g >= p.gapMs[0] && g <= p.gapMs[1]);
    }
  }
});

test("jitter only ever lengthens, by at most 40%", () => {
  assert.equal(pacing.jitter(1000, 0.4, lo), 1000);
  assert.equal(pacing.jitter(1000, 0.4, hi), 1400);
  for (let i = 0; i < 200; i++) {
    const j = pacing.jitter(2500);
    assert.ok(j >= 2500 && j <= 3500);
  }
});

test("typing and digit delays: one per char, bounded", () => {
  const d = pacing.typingDelays("Hi Priya, welcome");
  assert.equal(d.length, 17);
  for (const ms of d) assert.ok(ms >= 45 && ms <= 140 + 450);
  const g = pacing.digitDelays("918595856713");
  assert.equal(g.length, 12);
  for (const ms of g) assert.ok(ms >= 70 && ms <= 220 + 600);
});

test("composeDwellMs clamps then jitters", () => {
  assert.equal(pacing.composeDwellMs(10, lo), 1200);
  assert.equal(pacing.composeDwellMs(100000, lo), 4500);
  assert.equal(pacing.composeDwellMs(200, lo), 3000);
});

test("splitForTyping: normal invite", () => {
  assert.deepEqual(pacing.splitForTyping("Hi Priya,\n\nYou're invited!\nThanks"), {
    head: "Hi Priya,",
    lineBreaks: 2,
    body: "You're invited!\nThanks",
  });
});

test("splitForTyping: CRLF is normalised", () => {
  assert.deepEqual(pacing.splitForTyping("Hello A,\r\n\r\nBody"), { head: "Hello A,", lineBreaks: 2, body: "Body" });
});

test("splitForTyping: single line is typed whole", () => {
  assert.deepEqual(pacing.splitForTyping("Hi Priya"), { head: "Hi Priya", lineBreaks: 0, body: "" });
});

test("splitForTyping: unsafe first lines fall back to a full paste", () => {
  for (const text of ["Hi José,\n\nx", "Hi 🎉\nx", "Hi: there\nx", "\nHi", "Hi (A)\nx", "x".repeat(pacing.MAX_TYPED_HEAD + 1) + "\nmore"]) {
    const t = text.replace(/\r\n/g, "\n");
    assert.deepEqual(pacing.splitForTyping(text), { head: "", lineBreaks: 0, body: t }, JSON.stringify(text));
  }
});
