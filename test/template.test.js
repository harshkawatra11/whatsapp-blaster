const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMessageText, varyGreeting } = require("../template");

const pickHi = () => 0.1;
const pickHello = () => 0.9;

test("Hi <-> Hello swap keeps case and the rest of the text", () => {
  assert.equal(varyGreeting("Hi Priya,\n\nBody", pickHello), "Hello Priya,\n\nBody");
  assert.equal(varyGreeting("Hello Priya,\n\nBody", pickHi), "Hi Priya,\n\nBody");
  assert.equal(varyGreeting("hello there", pickHi), "hi there");
  assert.equal(varyGreeting("HELLO TEAM", pickHi), "HI TEAM");
  assert.equal(varyGreeting("  Hi,", pickHello), "  Hello,");
});

test("non-greeting openings are untouched", () => {
  for (const s of ["History lesson", "Hillary", "Hey Priya", "Dear Priya, hi", "Highlights"]) {
    assert.equal(varyGreeting(s, pickHello), s);
  }
});

test("buildMessageText is deterministic unless varyGreeting is requested", () => {
  const row = { name: "Priya" };
  assert.equal(buildMessageText(row, "Hi {{name}},", "there"), "Hi Priya,");
  assert.equal(buildMessageText(row, "Hi {{name}},", "there", { varyGreeting: true, rand: pickHello }), "Hello Priya,");
  assert.equal(buildMessageText({ name: "" }, "Hello {{name}}", "there", { varyGreeting: true, rand: pickHi }), "Hi there");
});
