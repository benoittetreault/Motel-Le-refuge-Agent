import { test } from "node:test";
import assert from "node:assert/strict";
import { orchestrateBookingSms, type BookingSmsDeps, type BookingSmsInput } from "./booking-sms";
import { createSentLinkStore } from "./sent-link-store";
import type { AvailabilityResult } from "../anthropic/availability";
import type { SmsResult } from "../../lib/sms";
import type { ChatMessageList } from "../anthropic/chat-brain";

// A real, parseable Reservit link (arrival 2026-09-15, 2 nights, 2 adults).
const LINK =
  "http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";
const LINK2 =
  "http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=4";

const SPOKEN_OPTS = { phone: "819-564-9005", hours: "15h00 - 21h00 (3 PM - 9 PM) daily" };

// A tiny recording harness for the injected deps.
interface Recorder {
  availabilityCalls: Array<{ arrivalDate: string; nights: number; adults: number }>;
  smsCalls: Array<{ to: string; body: string }>;
}

function makeDeps(opts: {
  availability?: AvailabilityResult | AvailabilityResult[];
  sms?: SmsResult;
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
    sendSms: async (to, body) => {
      rec?.smsCalls.push({ to, body });
      return opts.sms ?? { ok: true, sid: "SMtest" };
    },
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
    spokenOpts: SPOKEN_OPTS,
    ...overrides,
  };
}

// A spoken reply must NEVER contain a URL.
function assertNoUrl(reply: string): void {
  assert.doesNotMatch(reply, /reservit\.com|softbooker|https?:\/\//i, `spoken reply leaked a URL: ${reply}`);
}

test("available + valid metadata number → sends once, speaks the sent-confirmation", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ availability: { status: "all_available", firstPrice: 100 }, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls.length, 1);
  assert.equal(rec.smsCalls[0].to, "+15195551234");
  assert.match(rec.smsCalls[0].body, /reservit\.com/); // the SMS body DOES carry the link
  assert.match(outcome.reply, /texto|text message/i);
  assertNoUrl(outcome.reply); // but the SPOKEN reply never does
});

test("SMS failure → does NOT claim a send, invites to call, does not mark sent", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ sms: { ok: false, reason: "twilio_error" }, store, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "send_failed");
  assert.equal(outcome.smsReason, "twilio_error");
  assert.match(outcome.reply, /appelez-nous|call us/i);
  assert.doesNotMatch(outcome.reply, /texto|text message/i); // never a false "sent"
  assertNoUrl(outcome.reply);
  // Not marked → a later turn is free to retry.
  assert.equal(store.alreadySent("call-1", LINK), false);
});

test("no guest number (no metadata, no keypad) → no_number, no SMS attempted", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });

  const outcome = await orchestrateBookingSms(
    baseInput({ callerNumber: undefined, messages: [{ role: "user", content: "book it" }] }),
    deps
  );

  assert.equal(outcome.status, "no_number");
  assert.equal(rec.smsCalls.length, 0);
  assert.match(outcome.reply, /appelez-nous|call us/i);
  assertNoUrl(outcome.reply);
});

test("invalid metadata number falls back to a DTMF keypad entry", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });

  const outcome = await orchestrateBookingSms(
    baseInput({
      callerNumber: "anonymous", // not E.164
      messages: [{ role: "user", content: "User's Keypad Entry: 8195551234" }],
    }),
    deps
  );

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls[0].to, "+18195551234");
});

test("dates not available (hard failure) → not_available, no SMS", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ availability: { status: "none_available" }, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "not_available");
  assert.equal(rec.smsCalls.length, 0);
  assert.match(outcome.reply, /appelez-nous|call us/i);
  assertNoUrl(outcome.reply);
});

test("check_failed (Reservit unreachable) does NOT block the send", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ availability: { status: "check_failed" }, rec });

  const outcome = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(outcome.status, "sent");
  assert.equal(rec.smsCalls.length, 1);
});

test("repeated turn with the same link → duplicate, no second SMS, still confirms", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ store, rec });

  const first = await orchestrateBookingSms(baseInput(), deps);
  const second = await orchestrateBookingSms(baseInput(), deps);

  assert.equal(first.status, "sent");
  assert.equal(second.status, "duplicate");
  assert.equal(rec.smsCalls.length, 1); // exactly one SMS across both turns
  assert.match(second.reply, /texto|text message/i);
  // A duplicate turn must not even re-hit Reservit.
  assert.equal(rec.availabilityCalls.length, 1);
});

test("dedup is keyed per send SUCCESS: a failed send then a retry sends again", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };

  // Turn 1: Twilio fails.
  const failDeps = makeDeps({ sms: { ok: false, reason: "timeout" }, store, rec });
  const first = await orchestrateBookingSms(baseInput(), failDeps);
  assert.equal(first.status, "send_failed");

  // Turn 2: Twilio recovers — the same link must be retried, not deduped away.
  const okDeps = makeDeps({ sms: { ok: true, sid: "SMok" }, store, rec });
  const second = await orchestrateBookingSms(baseInput(), okDeps);
  assert.equal(second.status, "sent");
  assert.equal(rec.smsCalls.length, 2);
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

test("multiple different links, all available → one SMS carrying both", async () => {
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

test("an unparseable link is not verifiable → not blocked (sent)", async () => {
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ rec });
  // A link that matches the pattern but has no query params to parse.
  const bad = "http://softbooker.reservit.com/reservit/reserhotel.php?garbage";

  const outcome = await orchestrateBookingSms(baseInput({ links: [bad] }), deps);

  assert.equal(outcome.status, "sent");
  assert.equal(rec.availabilityCalls.length, 0); // nothing parseable to check
  assert.equal(rec.smsCalls.length, 1);
});

test("undefined callId still sends (no dedup), never throws", async () => {
  const store = createSentLinkStore();
  const rec: Recorder = { availabilityCalls: [], smsCalls: [] };
  const deps = makeDeps({ store, rec });

  const first = await orchestrateBookingSms(baseInput({ callId: undefined }), deps);
  const second = await orchestrateBookingSms(baseInput({ callId: undefined }), deps);

  // Without a callId we cannot dedup — both turns send. (Acceptable: Vapi always
  // provides a call id in practice; this only guards against a malformed payload.)
  assert.equal(first.status, "sent");
  assert.equal(second.status, "sent");
  assert.equal(rec.smsCalls.length, 2);
});
