import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolResults, type ToolUseLike } from "./tool-results";

// A fake availability checker that echoes its arguments back, so a test can prove
// each tool_use was answered with a check run on ITS OWN input (no cross-wiring).
function echoingCheck() {
  const calls: Array<{ arrivalDate: string; nights: number; adults: number }> = [];
  const runCheck = async (arrivalDate: string, nights: number, adults: number) => {
    calls.push({ arrivalDate, nights, adults });
    return { status: "all_available", echo: { arrivalDate, nights, adults } };
  };
  return { runCheck, calls };
}

test("two parallel check_availability calls each get a tool_result with the right id", async () => {
  // Simulates the Double + Queen turn: the model emits TWO check_availability
  // tool_use blocks in one response (plus a leading text block, as usual).
  const content: ToolUseLike[] = [
    { type: "text" },
    {
      type: "tool_use",
      id: "toolu_double",
      name: "check_availability",
      input: { arrivalDate: "2026-09-10", nights: 3, adults: 2 },
    },
    {
      type: "tool_use",
      id: "toolu_queen",
      name: "check_availability",
      input: { arrivalDate: "2026-09-10", nights: 3, adults: 1 },
    },
  ];

  const { runCheck, calls } = echoingCheck();
  const results = await buildToolResults(content, runCheck);

  // Exactly one tool_result per tool_use — none dropped, none duplicated.
  assert.equal(results.length, 2);
  assert.equal(calls.length, 2);

  // Every result is a tool_result block…
  for (const r of results) assert.equal(r.type, "tool_result");

  // …and the ids line up in order with the two tool_use blocks.
  assert.deepEqual(
    results.map((r) => r.tool_use_id),
    ["toolu_double", "toolu_queen"]
  );

  // Each result reflects a check run on ITS OWN input (not the other block's) —
  // proving the results were not cross-wired.
  const double = JSON.parse(results[0].content);
  const queen = JSON.parse(results[1].content);
  assert.deepEqual(double.echo, { arrivalDate: "2026-09-10", nights: 3, adults: 2 });
  assert.deepEqual(queen.echo, { arrivalDate: "2026-09-10", nights: 3, adults: 1 });

  // Belt-and-suspenders: no tool_use id is left unanswered.
  const answered = new Set(results.map((r) => r.tool_use_id));
  assert.ok(answered.has("toolu_double"));
  assert.ok(answered.has("toolu_queen"));
});

test("a non-check_availability tool_use still gets a check_failed tool_result", async () => {
  const content: ToolUseLike[] = [
    { type: "tool_use", id: "toolu_known", name: "check_availability", input: { arrivalDate: "2026-09-10", nights: 2, adults: 2 } },
    { type: "tool_use", id: "toolu_unknown", name: "some_other_tool", input: { foo: "bar" } },
  ];

  const { runCheck, calls } = echoingCheck();
  const results = await buildToolResults(content, runCheck);

  // Both tool_use blocks are answered; runCheck ran only for the known one.
  assert.equal(results.length, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    results.map((r) => r.tool_use_id),
    ["toolu_known", "toolu_unknown"]
  );
  assert.deepEqual(JSON.parse(results[1].content), { status: "check_failed" });
});

test("ordering is preserved even when checks resolve out of order", async () => {
  // First check resolves LAST — Promise.all(map) must still align results by
  // position, so tool_use_id order is stable regardless of resolution timing.
  const runCheck = async (arrivalDate: string, nights: number, adults: number) => {
    const delay = adults === 2 ? 30 : 0; // the "double" (adults=2) resolves later
    await new Promise((r) => setTimeout(r, delay));
    return { status: "all_available", adults };
  };
  const content: ToolUseLike[] = [
    { type: "tool_use", id: "toolu_double", name: "check_availability", input: { arrivalDate: "2026-09-10", nights: 3, adults: 2 } },
    { type: "tool_use", id: "toolu_queen", name: "check_availability", input: { arrivalDate: "2026-09-10", nights: 3, adults: 1 } },
  ];

  const results = await buildToolResults(content, runCheck);
  assert.deepEqual(
    results.map((r) => r.tool_use_id),
    ["toolu_double", "toolu_queen"]
  );
  assert.equal(JSON.parse(results[0].content).adults, 2);
  assert.equal(JSON.parse(results[1].content).adults, 1);
});

test("a turn with no tool_use blocks yields no tool_results", async () => {
  const content: ToolUseLike[] = [{ type: "text" }];
  const { runCheck, calls } = echoingCheck();
  const results = await buildToolResults(content, runCheck);
  assert.equal(results.length, 0);
  assert.equal(calls.length, 0);
});
