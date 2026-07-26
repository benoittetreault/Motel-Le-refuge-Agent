import { test } from "node:test";
import assert from "node:assert/strict";
import { createSentLinkStore } from "./sent-link-store";

test("a key is not 'sent' until marked", () => {
  const store = createSentLinkStore();
  assert.equal(store.alreadySent("call-1", "k"), false);
  store.markSent("call-1", "k");
  assert.equal(store.alreadySent("call-1", "k"), true);
});

test("dedup is scoped per call id AND per key", () => {
  const store = createSentLinkStore();
  store.markSent("call-1", "kA");
  // Same key, different call → independent.
  assert.equal(store.alreadySent("call-2", "kA"), false);
  // Same call, different key → independent.
  assert.equal(store.alreadySent("call-1", "kB"), false);
  assert.equal(store.alreadySent("call-1", "kA"), true);
});

test("entries expire after the TTL", () => {
  let now = 1_000_000;
  const store = createSentLinkStore(1000, () => now); // 1s TTL, injectable clock
  store.markSent("call-1", "k");
  assert.equal(store.alreadySent("call-1", "k"), true);

  now += 999; // still within TTL
  assert.equal(store.alreadySent("call-1", "k"), true);

  now += 2; // now past the 1000ms TTL
  assert.equal(store.alreadySent("call-1", "k"), false);
});

test("re-marking a key refreshes its expiry", () => {
  let now = 0;
  const store = createSentLinkStore(1000, () => now);
  store.markSent("call-1", "k");
  now = 900;
  store.markSent("call-1", "k"); // refresh at t=900 → new expiry t=1900
  now = 1500;
  assert.equal(store.alreadySent("call-1", "k"), true);
  now = 2000;
  assert.equal(store.alreadySent("call-1", "k"), false);
});

test("a composite key cannot be forged by concatenating callId and key", () => {
  // The store must not treat ("a b", "c") and ("a", "b c") as the same entry.
  const store = createSentLinkStore();
  store.markSent("a b", "c");
  assert.equal(store.alreadySent("a", "b c"), false);
});
