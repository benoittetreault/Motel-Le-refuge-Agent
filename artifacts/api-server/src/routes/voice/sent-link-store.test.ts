import { test } from "node:test";
import assert from "node:assert/strict";
import { createSentLinkStore } from "./sent-link-store";

test("first claim wins; a concurrent second claim sees in_flight", () => {
  const store = createSentLinkStore();
  assert.equal(store.claim("call-1", "k"), "claimed");
  // Same (callId, key) again before markSent/release → in-flight, must not send.
  assert.equal(store.claim("call-1", "k"), "in_flight");
});

test("markSent moves a claim to sent; later claims see already_sent", () => {
  const store = createSentLinkStore();
  assert.equal(store.claim("call-1", "k"), "claimed");
  store.markSent("call-1", "k");
  assert.equal(store.claim("call-1", "k"), "already_sent");
  assert.equal(store.claim("call-1", "k"), "already_sent");
});

test("release returns an in-flight claim to not-claimed (retryable)", () => {
  const store = createSentLinkStore();
  assert.equal(store.claim("call-1", "k"), "claimed");
  store.release("call-1", "k");
  // After release the same key can be claimed fresh (a retry).
  assert.equal(store.claim("call-1", "k"), "claimed");
});

test("release never un-sends a completed send", () => {
  const store = createSentLinkStore();
  store.claim("call-1", "k");
  store.markSent("call-1", "k");
  store.release("call-1", "k"); // must be a no-op on a sent entry
  assert.equal(store.claim("call-1", "k"), "already_sent");
});

test("claims are scoped per call id AND per key", () => {
  const store = createSentLinkStore();
  store.claim("call-1", "kA");
  // Same key, different call → independent.
  assert.equal(store.claim("call-2", "kA"), "claimed");
  // Same call, different key → independent.
  assert.equal(store.claim("call-1", "kB"), "claimed");
});

test("entries expire after the TTL (both in-flight and sent)", () => {
  let now = 1_000_000;
  const store = createSentLinkStore(1000, () => now); // 1s TTL, injectable clock

  // A sent entry expires.
  store.claim("call-1", "k");
  store.markSent("call-1", "k");
  assert.equal(store.claim("call-1", "k"), "already_sent");
  now += 1001;
  assert.equal(store.claim("call-1", "k"), "claimed"); // expired → claimable again

  // An abandoned in-flight claim also expires (guards against a crash mid-send).
  now += 1; // start fresh
  const store2 = createSentLinkStore(1000, () => now);
  store2.claim("call-2", "k");
  assert.equal(store2.claim("call-2", "k"), "in_flight");
  now += 1001;
  assert.equal(store2.claim("call-2", "k"), "claimed");
});

test("markSent refreshes expiry", () => {
  let now = 0;
  const store = createSentLinkStore(1000, () => now);
  store.claim("call-1", "k");
  now = 900;
  store.markSent("call-1", "k"); // refresh at t=900 → new expiry t=1900
  now = 1500;
  assert.equal(store.claim("call-1", "k"), "already_sent");
  now = 2000;
  assert.equal(store.claim("call-1", "k"), "claimed");
});

test("a composite key cannot be forged by concatenating callId and key", () => {
  // The store must not treat ("a b", "c") and ("a", "b c") as the same entry.
  const store = createSentLinkStore();
  store.claim("a b", "c");
  assert.equal(store.claim("a", "b c"), "claimed");
});
