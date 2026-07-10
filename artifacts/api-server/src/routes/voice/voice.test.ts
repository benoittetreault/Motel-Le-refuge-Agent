import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapVapiMessages,
  secretMatches,
  extractProvidedSecret,
  toSpokenReply,
  buildSseChunks,
  formatSsePayload,
  buildVoiceDebugInfo,
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

const SSE_META = { id: "chatcmpl-abc", model: "custom-llm", created: 1_700_000_000 };

test("buildSseChunks: role-first, full text in one content delta, stop last", () => {
  const chunks = buildSseChunks("Bonjour, une chambre ?", SSE_META);
  assert.equal(chunks.length, 3);

  // Every chunk carries the shared envelope.
  for (const c of chunks) {
    assert.equal(c.object, "chat.completion.chunk");
    assert.equal(c.id, "chatcmpl-abc");
    assert.equal(c.model, "custom-llm");
    assert.equal(c.created, 1_700_000_000);
  }

  const deltas = chunks.map((c) => (c.choices as any[])[0].delta);
  const finishes = chunks.map((c) => (c.choices as any[])[0].finish_reason);
  assert.deepEqual(deltas[0], { role: "assistant", content: "" });
  assert.deepEqual(deltas[1], { content: "Bonjour, une chambre ?" });
  assert.deepEqual(deltas[2], {});
  assert.deepEqual(finishes, [null, null, "stop"]);

  // Concatenated content across deltas equals the full reply (Vapi's accumulator).
  const joined = deltas.map((d) => (d.content as string) ?? "").join("");
  assert.equal(joined, "Bonjour, une chambre ?");
});

test("formatSsePayload: data-prefixed lines, valid JSON, [DONE] terminator", () => {
  const reply = "Parfait, c'est disponible !";
  const payload = formatSsePayload(reply, SSE_META);

  assert.ok(payload.endsWith("data: [DONE]\n\n"), "must end with the [DONE] sentinel");

  const frames = payload.split("\n\n").filter((f) => f.length > 0);
  assert.equal(frames.length, 4); // 3 chunks + [DONE]
  for (const f of frames) assert.ok(f.startsWith("data: "), `frame must be data-prefixed: ${f}`);

  // The three chunk frames are valid chat.completion.chunk JSON.
  const parsed = frames.slice(0, 3).map((f) => JSON.parse(f.slice("data: ".length)));
  assert.equal(parsed[2].choices[0].finish_reason, "stop");
  assert.equal(parsed[1].choices[0].delta.content, reply);

  // The reply text must never appear outside a JSON string (no raw injection).
  assert.equal(frames[3], "data: [DONE]");
});

// A payload shaped like a real Vapi turn: the fields we WANT alongside the
// sprawl of secrets/PII we must never log (headers, SIP identity token embedded
// in a raw blob, the assistant-config echo carrying a duplicate x-vapi-secret,
// carrier SIDs, variableValues).
const SPRAWLING_VAPI_PAYLOAD = {
  model: "gpt-4",
  messages: [
    { role: "system", content: "Vapi prompt to ignore" },
    { role: "user", content: "Je veux réserver" },
    { role: "user", content: "User's Keypad Entry: 8194379713" },
  ],
  call: {
    id: "call-abc-123",
    phoneNumber: { number: "+18195649005" },
    customer: { number: "+18194379713" },
    phoneCallProviderDetails: {
      sip: {
        raw: 'INVITE sip:...;Identity: "eyJhbGciOiJFUzI1Ni000SHAKEN-STIR-IDENTITY-TOKEN"',
      },
      accountSid: "ACdeadbeefdeadbeefdeadbeefdeadbeef",
    },
    assistant: {
      model: {
        provider: "custom-llm",
        headers: { "x-vapi-secret": "SUPER_SECRET_SHARED_VALUE" },
      },
    },
    variableValues: { foo: "bar" },
  },
  headers: {
    "x-vapi-secret": "SUPER_SECRET_SHARED_VALUE",
    authorization: "Bearer SUPER_SECRET_BEARER_TOKEN",
    identity: "SHAKEN-STIR-IDENTITY-TOKEN",
  },
};

test("buildVoiceDebugInfo keeps only the curated fields, no secrets/PII sprawl", () => {
  const mapped = mapVapiMessages(SPRAWLING_VAPI_PAYLOAD.messages);
  const info = buildVoiceDebugInfo(SPRAWLING_VAPI_PAYLOAD, mapped, "call-abc-123");

  // What we DO want: the mapped messages (incl. the keypad entry), the caller
  // number, the dialed number, callId, and a count.
  assert.equal(info.callId, "call-abc-123");
  assert.equal(info.dialedNumber, "+18195649005");
  assert.equal(info.callerNumber, "+18194379713");
  assert.equal(info.messageCount, 2);
  assert.deepEqual(info.messages, [
    { role: "user", content: "Je veux réserver" },
    { role: "user", content: "User's Keypad Entry: 8194379713" },
  ]);
  assert.ok(
    info.messages.some((m) => String(m.content).includes("Keypad Entry")),
    "the keypad entry must be visible in the debug info"
  );

  // What must NEVER be present: assert on both the shape (no stray keys) and the
  // fully-serialized blob (no secret/identity value survives anywhere within).
  assert.deepEqual(Object.keys(info).sort(), [
    "callId",
    "callerNumber",
    "dialedNumber",
    "messageCount",
    "messages",
  ]);

  const serialized = JSON.stringify(info);
  for (const forbidden of [
    "x-vapi-secret",
    "SUPER_SECRET_SHARED_VALUE",
    "authorization",
    "Bearer",
    "SUPER_SECRET_BEARER_TOKEN",
    "identity",
    "SHAKEN-STIR-IDENTITY-TOKEN",
    "sip",
    "phoneCallProviderDetails",
    "assistant",
    "accountSid",
    "ACdeadbeefdeadbeefdeadbeefdeadbeef",
    "variableValues",
  ]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(forbidden, "i"),
      `curated debug info must not contain "${forbidden}"`
    );
  }
});
