import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestAvailability } from "./availability";
import type { AvailabilityResult, CheckAvailabilityFn } from "./availability";

// A counting fake check so we can assert exactly how many network checks happen.
function countingCheck(result: AvailabilityResult = { status: "all_available", firstPrice: 100 }): {
  fn: CheckAvailabilityFn;
  calls: Array<{ fromDate: string; nights: number; adults: number }>;
} {
  const calls: Array<{ fromDate: string; nights: number; adults: number }> = [];
  return {
    calls,
    fn: async (fromDate, nights, adults) => {
      calls.push({ fromDate, nights, adults });
      return result;
    },
  };
}

test("same query is only checked once per request (dedup)", async () => {
  const { fn, calls } = countingCheck();
  const availability = createRequestAvailability(fn);

  const a = await availability("2026-09-15", 2, 2);
  const b = await availability("2026-09-15", 2, 2); // identical → cache hit
  const c = await availability("2026-09-15", 2, 2);

  assert.equal(calls.length, 1, "the underlying check must run exactly once");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("cached result is reused ONLY for exactly matching params", async () => {
  const { fn, calls } = countingCheck();
  const availability = createRequestAvailability(fn);

  await availability("2026-09-15", 2, 2);
  await availability("2026-09-16", 2, 2); // different date
  await availability("2026-09-15", 3, 2); // different nights
  await availability("2026-09-15", 2, 4); // different adults
  await availability("2026-09-15", 2, 2); // repeat of the first → cache hit

  // 4 distinct queries → 4 checks; the 5th is a hit.
  assert.equal(calls.length, 4);
  assert.deepEqual(calls, [
    { fromDate: "2026-09-15", nights: 2, adults: 2 },
    { fromDate: "2026-09-16", nights: 2, adults: 2 },
    { fromDate: "2026-09-15", nights: 3, adults: 2 },
    { fromDate: "2026-09-15", nights: 2, adults: 4 },
  ]);
});

test("concurrent identical calls share one in-flight request", async () => {
  const { fn, calls } = countingCheck();
  const availability = createRequestAvailability(fn);

  const [a, b] = await Promise.all([
    availability("2026-09-15", 2, 2),
    availability("2026-09-15", 2, 2),
  ]);

  assert.equal(calls.length, 1, "the in-flight promise is shared, not re-issued");
  assert.deepEqual(a, b);
});

test("the cache is request-scoped: a new instance does not reuse old results", async () => {
  const first = countingCheck({ status: "none_available" });
  const av1 = createRequestAvailability(first.fn);
  await av1("2026-09-15", 2, 2);

  // A fresh request → fresh cache → the underlying check runs again.
  const second = countingCheck({ status: "all_available", firstPrice: 100 });
  const av2 = createRequestAvailability(second.fn);
  const r = await av2("2026-09-15", 2, 2);

  assert.equal(second.calls.length, 1);
  assert.deepEqual(r, { status: "all_available", firstPrice: 100 });
});

test("timing sink records a check and a subsequent cache hit", async () => {
  const { fn } = countingCheck();
  const marks: Array<{ label: string; ms: number }> = [];
  const availability = createRequestAvailability(fn, (label, ms) => marks.push({ label, ms }));

  await availability("2026-09-15", 2, 2);
  await availability("2026-09-15", 2, 2);

  const labels = marks.map((m) => m.label);
  assert.ok(labels.includes("check_availability"), "records the real check duration");
  assert.ok(labels.includes("availability_cache_hit"), "records the cache hit");
});
