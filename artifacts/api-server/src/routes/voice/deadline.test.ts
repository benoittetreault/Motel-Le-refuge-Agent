import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceDeadline, withDeadline } from "./deadline";

const never = new Promise<string>(() => {}); // never settles

test("withDeadline resolves the real result when work finishes in time", async () => {
  const deadline = createVoiceDeadline(1000);
  try {
    const result = await withDeadline(Promise.resolve("real reply"), deadline, () => "fallback");
    assert.equal(result, "real reply");
  } finally {
    deadline.clear();
  }
});

test("withDeadline resolves the fallback when the deadline fires first", async () => {
  const deadline = createVoiceDeadline(20); // 20ms
  try {
    const result = await withDeadline(never, deadline, () => "safe fallback");
    assert.equal(result, "safe fallback");
  } finally {
    deadline.clear();
  }
});

test("withDeadline propagates a work rejection that beats the deadline", async () => {
  const deadline = createVoiceDeadline(1000);
  try {
    await assert.rejects(
      () => withDeadline(Promise.reject(new Error("boom")), deadline, () => "fallback"),
      /boom/
    );
  } finally {
    deadline.clear();
  }
});

test("withDeadline: a late work rejection after fallback does not throw", async () => {
  const deadline = createVoiceDeadline(10);
  // Work rejects AFTER the deadline has already resolved the fallback.
  const late = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late")), 40));
  try {
    const result = await withDeadline(late, deadline, () => "fallback");
    assert.equal(result, "fallback");
    // Give the late rejection time to fire; it must be swallowed (handler attached).
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    deadline.clear();
  }
});

test("createVoiceDeadline reports expired/remaining via an injected clock", () => {
  let now = 1_000_000;
  const deadline = createVoiceDeadline(15_000, () => now);
  try {
    assert.equal(deadline.expired(), false);
    assert.equal(deadline.remainingMs(), 15_000);
    now += 14_000;
    assert.equal(deadline.expired(), false);
    assert.equal(deadline.remainingMs(), 1_000);
    now += 2_000; // past the deadline
    assert.equal(deadline.expired(), true);
    assert.equal(deadline.remainingMs(), 0); // never negative
  } finally {
    deadline.clear();
  }
});

test("createVoiceDeadline exposes an AbortSignal that fires on timeout", async () => {
  const deadline = createVoiceDeadline(15);
  try {
    assert.equal(deadline.signal.aborted, false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(deadline.signal.aborted, true);
  } finally {
    deadline.clear();
  }
});
