import { test } from "node:test";
import assert from "node:assert/strict";
import { stripToolTags } from "./strip-tool-tags";

// Helper: assert that no XML-like tool-syntax tag survives in the output.
function assertNoToolTags(s: string): void {
  assert.doesNotMatch(
    s,
    /<\/?[a-zA-Z][\w.:-]*(?:tool|function|invoke|call|result|response)/i,
    `unexpected tool-like tag left in output: ${JSON.stringify(s)}`
  );
}

test("old format: <tool_call>/<tool_response> blocks are stripped, prose kept", () => {
  const input =
    'Bonjour ! <tool_call>{"name":"check_availability","input":{"nights":3}}</tool_call> ' +
    '<tool_response>{"status":"all_available"}</tool_response> Voici votre disponibilité.';
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, true);
  assert.equal(text, "Bonjour ! Voici votre disponibilité.");
  assertNoToolTags(text);
});

test("new format: <function_calls>/<invoke>/<function_response> is fully stripped", () => {
  // Exact shape reported leaking to a guest in live testing.
  const input =
    "Voici la réponse. " +
    '<function_calls> <invoke name="check_availability"> ' +
    '<parameter name="checkin_date">2026-09-10</parameter> ' +
    '<parameter name="num_nights">3</parameter> ' +
    '<parameter name="num_adults">2</parameter> ' +
    "</invoke> </function_calls> " +
    '<function_response>{"status":"all_available"}</function_response> ' +
    "C'est disponible !";
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, true);
  assert.equal(text, "Voici la réponse. C'est disponible !");
  assertNoToolTags(text);
  // The nested inner tags must be gone too, not just the outer container.
  assert.doesNotMatch(text, /parameter|invoke/i);
});

test("invented never-before-seen format is stripped by keyword, not by exact name", () => {
  // A shape we have NOT hard-coded anywhere: different tag names, mixed case,
  // attributes, and nesting. It should still be caught purely by the keywords.
  const input =
    "Réponse. " +
    '<ToolInvocation id="7"><ActionCall tool="lookup"><arg>x</arg></ActionCall></ToolInvocation>' +
    "<FunctionOutput>done</FunctionOutput> Fin.";
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, true);
  assert.equal(text, "Réponse. Fin.");
  assertNoToolTags(text);
});

test("legitimate text with unrelated angle brackets is left untouched", () => {
  const input =
    "Nos chambres accueillent 2 < 4 personnes, et les prix sont > 100 $ mais < 250 $. " +
    "Réservez pour 3 nuits !";
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, false);
  assert.equal(text, input); // byte-for-byte unchanged
});

test("truncated tool-syntax at the end is removed, preceding prose is kept", () => {
  // Model was cut off mid tool-call — no closing tags at all.
  const input =
    'Parfait, un instant. <function_calls> <invoke name="check_availability"> <parameter name="checkin_date">2026-09';
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, true);
  assert.equal(text, "Parfait, un instant.");
  assertNoToolTags(text);
});

test("a truncated tool-response (open tag, no close) is removed", () => {
  const input = 'Voici. <function_response>{"status":"all_availab';
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, true);
  assert.equal(text, "Voici.");
  assertNoToolTags(text);
});

test("innocuous non-tool markup is preserved even while a tool block is removed", () => {
  const input =
    "Prix <b>spécial</b> ce weekend. " +
    "<tool_call>{\"x\":1}</tool_call> Réservez vite !";
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, true);
  assert.equal(text, "Prix <b>spécial</b> ce weekend. Réservez vite !");
});

test("plain text with no tags is returned unchanged", () => {
  const input = "Bonjour ! Comment puis-je vous aider aujourd'hui ?";
  const { text, stripped } = stripToolTags(input);
  assert.equal(stripped, false);
  assert.equal(text, input);
});
