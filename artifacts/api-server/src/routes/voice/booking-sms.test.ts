import { test } from "node:test";
import assert from "node:assert/strict";
import { orchestrateBookingSms, type BookingSmsDeps, type BookingSmsInput } from "./booking-sms";
import { createSentLinkStore } from "./sent-link-store";
import type { AvailabilityResult } from "../anthropic/availability";
import type { SmsResult } from "../../lib/sms";

const HOTEL = "444801";
const LINK_BASE = "http://softbooker.reservit.com/reservit/reserhotel.php";

// Links as findAllReservitLinks yields them (protocol stripped by the pattern).
// Valid, for OUR hotel, 2026-09-15 / 2 nights / N adults.
const LINK = "softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";
const LINK2 = "softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=4";

const SPOKEN_OPTS = { phone: "819-564-9005", hours: "15h00 - 21h00 (3 PM - 9 PM) daily" };

interface Recorder {
  availabilityCalls: Array<{ arrivalDate: string; nights: number; adults: number }>;
  smsCalls: Array<{ to: string; body: string }>;
}

function makeDeps(opts: {
  availability?: AvailabilityResult | AvailabilityResult[];
  sms?: SmsResult;
  sendSms?: (to: string, body: string) => Promise<SmsResult>;
  store?: BookingSmsDeps["store"];
  rec?: Recorder;
}): BookingSmsDeps {
  const rec = opts.rec;
  let availIdx = 0;
  return {
    checkAvailability: async (arrivalDate, nights, adults) => {
      rec?.availabilityCalls.push({ arrivalDate, nights, adults });
      const a = opts.availability ?? { status: "all_available", firstPrice: 100 };
      return Array.isArray(a) ? a[availIdx++] : a;
    },
    sendSms:
      opts.sendSms ??
      (async (to, body) => {
        rec?.smsCalls.push({ to, body });
        return opts.sms ?? { ok: true, sid: "SMtest" };
      }),
    store: opts.store ?? createSentLinkStore(),
  };
}

function baseInput(overrides: Partial<BookingSmsInput> = {}): BookingSmsInput {
  return {
    links: [LINK],
    callId: "call-1",
    callerNumber: "+15195551234",
    messages: [{ role: "user", content: "Je veux réserver" }],
    motelName: "Motel Le Refuge",
    bookingConfig: { hotelId: HOTEL, linkBase: LINK_BASE },
    spokenOpts: SPOKEN_OPTS,
    ...overrides,
  };
}

function assertNoUrl(reply: string): void {
  assert.doesNotMatch(reply, /reservit\.com|softbooker|https?:\/\//i, `spoken reply leaked a URL: ${reply}`);
}

// ---- Happy path -------------------------------------------------------------

test("valid available link + number → sends server-built URL once, confirms", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ availability: { status: "all_available", firstPrice: 100 }, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls.length, 1);
  assert.equal(rec.smsCalls[0].to, "+15195551234");
  // The SMS body carries the canonical, server-built URL for OUR hotel.
  assert.match(rec.smsCalls[0].body, /hotelid=444801/);
  assert.match(rec.smsCalls[0].body, /softbooker\.reservit\.com\/reservit\/reserhotel\.php/);
  assert.match(outcome.reply, /texto|text message/i);
  assertNoUrl(outcome.reply);
});

test("SMS failure → invite-to-call, releases claim, no false confirmation", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ sms: { ok: false, reason: "twilio_error" }, store, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "send_failed");
  assert.equal(outcome.smsReason, "twilio_error");
  assert.doesNotMatch(outcome.reply, /texto|text message/i);
  assertNoUrl(outcome.reply);
  // (That the claim was released so a later turn can retry is proven by the
  // dedicated "failed send then a retry sends again" test below.)
});

test("no guest number → no_number, no SMS attempted", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });

  const outcome = await orchestrateBookingSms(
    baseInput({ callerNumber: undefined, messages: [{ role: "user", content: "book it" }] }),
    deps
  );

  assert.equal(outcome.status, "no_number");
  assert.equal(rec.smsCalls.length, 0);
  assertNoUrl(outcome.reply);
});

test("invalid metadata number falls back to a DTMF keypad entry", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });

  const outcome = await orchestrateBookingSms(
    baseInput({
      callerNumber: "anonymous",
      messages: [{ role: "user", content: "User's Keypad Entry: 8195551234" }],
    }),
    deps
  );

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls[0].to, "+18195551234");
});

// ---- Availability -----------------------------------------------------------

test("definitive not-available → not_available, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ availability: { status: "none_available" }, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "not_available");
  assert.equal(rec.smsCalls.length, 0);
  assertNoUrl(outcome.reply);
});

test("check_failed (Reservit unreachable) is non-blocking → still sends", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ availability: { status: "check_failed" }, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls.length, 1);
});

// ---- Dedup / concurrency ----------------------------------------------------

test("repeated turn (sequential) → duplicate, no second SMS, still confirms", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ store, rec });

  const first = await orchestrateBookingSms(baseInput(), deps);
  const second = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(first.status, "sent");
  assert.equal(second.status, "duplicate");
  assert.equal(rec.smsCalls.length, 1);
  assert.match(second.reply, /texto|text message/i);
  assert.equal(rec.availabilityCalls.length, 1); // duplicate short-circuits before Reservit
});

test("two SIMULTANEOUS turns (Promise.all) send exactly once", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };

  // A deliberately slow send so both invocations overlap in time.
  const sendSms = async (to: string, body: string): Promise<SmsResult> => {
    rec.smsCalls.push({ to, body });
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, sid: "SMok" };
  };
  const deps = makeDeps({ store, rec, sendSms });

  const [a, b] = await Promise.all([
    orchestrateBookingSms(baseInput(), deps),
    orchestrateBookingSms(baseInput(), deps),
  ]);

  // Exactly one SMS goes out; the loser sees the in-flight claim and does NOT send.
  assert.equal(rec.smsCalls.length, 1, "sendSms must be called exactly once");
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["in_flight", "sent"]);
  // Neither reply leaks a URL, and the loser never falsely claims a send.
  assertNoUrl(a.reply);
  assertNoUrl(b.reply);
  const loser = a.status === "in_flight" ? a : b;
  assert.doesNotMatch(loser.reply, /texto|text message/i);
});

test("dedup keyed on send SUCCESS: a failed send then a retry sends again", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };

  const failDeps = makeDeps({ sms: { ok: false, reason: "timeout" }, store, rec });
  const first = await orchestrateBookingSms(baseInput(), failDeps);
  assert.equal(first.status, "send_failed");

  const okDeps = makeDeps({ sms: { ok: true, sid: "SMok" }, store, rec });
  const second = await orchestrateBookingSms(baseInput(), okDeps);
  assert.equal(second.status, "sent");
  assert.equal(rec.smsCalls.length, 2);
});

// ---- Multiple links ---------------------------------------------------------

test("multiple valid links, all available → one SMS carrying both canonical URLs", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({
    availability: [
      { status: "all_available", firstPrice: 100 },
      { status: "all_available", firstPrice: 120 },
    ],
    rec,
  });

  const outcome = await orchestrateBookingSms(baseInput({ links: [LINK, LINK2] }), deps);

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls.length, 1);
  assert.match(rec.smsCalls[0].body, /nbadt=2/);
  assert.match(rec.smsCalls[0].body, /nbadt=4/);
});

test("multiple links, one not available → blocked, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({
    availability: [
      { status: "all_available", firstPrice: 100 },
      { status: "none_available" },
    ],
    rec,
  });

  const outcome = await orchestrateBookingSms(baseInput({ links: [LINK, LINK2] }), deps);

  assert.equal(outcome.status, "not_available");
  assert.equal(rec.smsCalls.length, 0);
});

// ---- Strict link validation (untrusted model input) -------------------------

test("unparseable link → invalid_link, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });
  const bad = "softbooker.reservit.com/reservit/reserhotel.php?garbage";

  const outcome = await orchestrateBookingSms(baseInput({ links: [bad] }), deps);

  assert.equal(outcome.status, "invalid_link");
  assert.equal(rec.smsCalls.length, 0);
  assert.equal(rec.availabilityCalls.length, 0);
  assertNoUrl(outcome.reply);
});

test("wrong hostname → invalid_link, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });
  const evil =
    "softbooker.reservit.com.evil.example/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";

  const outcome = await orchestrateBookingSms(baseInput({ links: [evil] }), deps);
  assert.equal(outcome.status, "invalid_link");
  assert.equal(rec.smsCalls.length, 0);
});

test("wrong path → invalid_link, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });
  const wrongPath =
    "softbooker.reservit.com/evil/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";

  const outcome = await orchestrateBookingSms(baseInput({ links: [wrongPath] }), deps);
  assert.equal(outcome.status, "invalid_link");
  assert.equal(rec.smsCalls.length, 0);
});

test("wrong hotel id → invalid_link, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });
  const otherHotel =
    "softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=999999&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";

  const outcome = await orchestrateBookingSms(baseInput({ links: [otherHotel] }), deps);
  assert.equal(outcome.status, "invalid_link");
  assert.equal(rec.smsCalls.length, 0);
});

test("missing required parameter → invalid_link, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });
  const missingAdults =
    "softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2";

  const outcome = await orchestrateBookingSms(baseInput({ links: [missingAdults] }), deps);
  assert.equal(outcome.status, "invalid_link");
  assert.equal(rec.smsCalls.length, 0);
});

test("model extra query params cannot change the hotel or reach the guest", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });
  // Correct hotel, but the model tacks on junk + a second hotelid-like param.
  const withExtras =
    "softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2&evilRedirect=1&hotelid2=999999";

  const outcome = await orchestrateBookingSms(baseInput({ links: [withExtras] }), deps);

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls.length, 1);
  // The sent URL is rebuilt from config: our hotel, no injected params.
  assert.match(rec.smsCalls[0].body, /hotelid=444801/);
  assert.doesNotMatch(rec.smsCalls[0].body, /evilRedirect/);
  assert.doesNotMatch(rec.smsCalls[0].body, /999999/);
  assert.doesNotMatch(rec.smsCalls[0].body, /hotelid2/);
});

// ---- Idempotency guard ------------------------------------------------------

test("missing call id → missing_call_id, no SMS attempted", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });

  const outcome = await orchestrateBookingSms(baseInput({ callId: undefined }), deps);

  assert.equal(outcome.status, "missing_call_id");
  assert.equal(rec.smsCalls.length, 0);
  assert.equal(rec.availabilityCalls.length, 0);
  assertNoUrl(outcome.reply);
});
