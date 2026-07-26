import { test } from "node:test";
import assert from "node:assert/strict";
import { maskPhone } from "./redact";

test("maskPhone masks a valid E.164 number to +1******1234", () => {
  assert.equal(maskPhone("+15195551234"), "+1******1234");
  // The complete number never appears in the output.
  assert.doesNotMatch(maskPhone("+15195551234"), /5195551234/);
});

test("maskPhone keeps only the first two and last four characters", () => {
  const masked = maskPhone("+447911123456"); // UK-shaped, 13 chars
  assert.equal(masked, "+4*******3456");
  assert.doesNotMatch(masked, /911123/); // the middle digits are gone
});

test("maskPhone fully masks values too short to partially reveal", () => {
  assert.equal(maskPhone("12345"), "*****"); // 5 chars → all stars
  assert.equal(maskPhone("123456"), "******"); // 6 chars → still all stars
  // Nothing of the original survives.
  assert.doesNotMatch(maskPhone("123456"), /\d/);
});

test("maskPhone handles non-string / empty input safely", () => {
  assert.equal(maskPhone(undefined), "<no-number>");
  assert.equal(maskPhone(null), "<no-number>");
  assert.equal(maskPhone(15195551234), "<no-number>"); // a number, not a string
  assert.equal(maskPhone(""), "<no-number>");
  assert.equal(maskPhone("   "), "<no-number>");
  assert.equal(maskPhone({}), "<no-number>");
});

test("maskPhone never throws and always hides the middle for long inputs", () => {
  const masked = maskPhone("+1250" + "5".repeat(20));
  assert.match(masked, /^\+1\*+5555$/);
  assert.ok(masked.includes("*"));
});
