import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimings } from "./timing";

test("createTimings aggregates by label into count/total/max (numbers only)", () => {
  const t = createTimings();
  t.add("model_round", 100);
  t.add("model_round", 300);
  t.add("check_availability", 40);

  const s = t.summary();
  assert.deepEqual(s.model_round, { count: 2, totalMs: 400, maxMs: 300 });
  assert.deepEqual(s.check_availability, { count: 1, totalMs: 40, maxMs: 40 });
});

test("time() records the span duration under its label", async () => {
  let now = 0;
  const t = createTimings(() => now);
  const result = await t.time("orchestrate_sms", async () => {
    now += 250;
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(t.summary().orchestrate_sms, { count: 1, totalMs: 250, maxMs: 250 });
});

test("time() still records the span when the work throws", async () => {
  let now = 0;
  const t = createTimings(() => now);
  await assert.rejects(() =>
    t.time("generate_reply", async () => {
      now += 120;
      throw new Error("boom");
    })
  );
  assert.deepEqual(t.summary().generate_reply, { count: 1, totalMs: 120, maxMs: 120 });
});

test("summary contains only numeric fields (safe to log)", () => {
  const t = createTimings();
  t.add("model_round", 10);
  const s = t.summary();
  for (const entry of Object.values(s)) {
    for (const v of Object.values(entry)) assert.equal(typeof v, "number");
  }
});
