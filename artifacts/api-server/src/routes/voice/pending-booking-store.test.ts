import { test } from "node:test";
import assert from "node:assert/strict";
import { createPendingBookingStore, type PendingBooking } from "./pending-booking-store";

const sample: PendingBooking = {
  bookings: [
    { arrivalDate: "2026-09-15", day: 15, month: 9, year: 2026, nights: 2, adults: 2, lang: "EN" },
  ],
  canonicalUrls: [
    "http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2",
  ],
  key: "k",
  availability: "available",
};

test("set/get round-trips a pending booking per call", () => {
  const store = createPendingBookingStore();
  assert.equal(store.get("call-1"), undefined);
  store.set("call-1", sample);
  assert.deepEqual(store.get("call-1"), sample);
  // Scoped per call.
  assert.equal(store.get("call-2"), undefined);
});

test("clear forgets the pending booking", () => {
  const store = createPendingBookingStore();
  store.set("call-1", sample);
  store.clear("call-1");
  assert.equal(store.get("call-1"), undefined);
});

test("entries expire after the TTL", () => {
  let now = 0;
  const store = createPendingBookingStore(1000, () => now);
  store.set("call-1", sample);
  now = 999;
  assert.ok(store.get("call-1"));
  now = 1001;
  assert.equal(store.get("call-1"), undefined);
});

test("set refreshes the TTL", () => {
  let now = 0;
  const store = createPendingBookingStore(1000, () => now);
  store.set("call-1", sample);
  now = 900;
  store.set("call-1", sample); // refresh → expiry 1900
  now = 1500;
  assert.ok(store.get("call-1"));
});

test("stores only non-sensitive booking facts (no numbers/transcripts/secrets)", () => {
  const store = createPendingBookingStore();
  store.set("call-1", sample);
  const serialized = JSON.stringify(store.get("call-1"));
  // Keys are limited to the booking snapshot shape.
  assert.deepEqual(Object.keys(store.get("call-1") as object).sort(), [
    "availability",
    "bookings",
    "canonicalUrls",
    "key",
  ]);
  // No phone-number-shaped or secret-shaped content.
  assert.doesNotMatch(serialized, /\+\d{8,15}/);
});
