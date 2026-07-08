import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapVapiMessages,
  secretMatches,
  extractProvidedSecret,
  toSpokenReply,
} from "./concierge";

test("mapVapiMessages keeps only user/assistant text, drops system and tool", () => {
  const mapped = mapVapiMessages([
    { role: "system", content: "Vapi assistant prompt — must be ignored" },
    { role: "user", content: "Bonjour" },
    { role: "assistant", content: "Bonjour, comment puis-je aider ?" },
    { role: "tool", content: '{"status":"all_available"}' },
    { role: "user", content: "2 personnes" },
  ]);
  assert.deepEqual(mapped, [
    { role: "user", content: "Bonjour" },
    { role: "assistant", content: "Bonjour, comment puis-je aider ?" },
    { role: "user", content: "2 personnes" },
  ]);
});

test("mapVapiMessages drops empty/whitespace and non-string content", () => {
  const mapped = mapVapiMessages([
    { role: "user", content: "" },
    { role: "user", content: "   " },
    { role: "assistant", content: null },
    { role: "assistant", content: { text: "object not allowed" } },
    { role: "user", content: "ok" },
  ]);
  assert.deepEqual(mapped, [{ role: "user", content: "ok" }]);
});

test("secretMatches is true only for the exact secret", () => {
  assert.equal(secretMatches("s3cret", "s3cret"), true);
  assert.equal(secretMatches("s3cret", "wrong"), false);
  // Differing lengths must not throw and must return false.
  assert.equal(secretMatches("short", "a-much-longer-secret-value"), false);
});

test("extractProvidedSecret reads the custom header then Bearer", () => {
  assert.equal(
    extractProvidedSecret({ "x-vapi-secret": "abc" }, "x-vapi-secret"),
    "abc"
  );
  assert.equal(
    extractProvidedSecret({ authorization: "Bearer xyz" }, "x-vapi-secret"),
    "xyz"
  );
  // Custom header wins when both are present.
  assert.equal(
    extractProvidedSecret({ "x-vapi-secret": "abc", authorization: "Bearer xyz" }, "x-vapi-secret"),
    "abc"
  );
  assert.equal(extractProvidedSecret({}, "x-vapi-secret"), null);
});

const OPTS = { phone: "819-564-9005", hours: "15h00 - 21h00 (3 PM - 9 PM) daily" };

test("toSpokenReply replaces a link-bearing reply with an invite to call", () => {
  const candidate =
    "Parfait ! Voici votre lien de réservation : " +
    "http://softbooker.reservit.com/reservit/reserhotel.php?lang=FR&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";
  const spoken = toSpokenReply(candidate, OPTS);
  assert.doesNotMatch(spoken, /reservit\.com/);
  assert.doesNotMatch(spoken, /softbooker/);
  assert.match(spoken, /819-564-9005/);
  assert.match(spoken, /appelez-nous|call us/);
});

test("toSpokenReply leaves a normal reply untouched (no link)", () => {
  const candidate =
    "Pour un couple, je recommande la Chambre Queen à 100$ la nuit. Ça vous convient ?";
  assert.equal(toSpokenReply(candidate, OPTS), candidate);
});

test("toSpokenReply strips any stray tool-syntax leakage", () => {
  const candidate =
    'Bonjour ! <tool_call>{"name":"check_availability"}</tool_call> C\'est disponible.';
  const spoken = toSpokenReply(candidate, OPTS);
  assert.doesNotMatch(spoken, /tool_call/);
  assert.match(spoken, /Bonjour/);
  assert.match(spoken, /disponible/);
});
