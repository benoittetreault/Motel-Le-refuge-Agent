import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendBookingLinkSms } from "./sms";

// ---- Test harness: mock global.fetch and the Twilio env vars ----------------

const TWILIO_ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_FAIL_SAFE",
] as const;

const savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

// Every fetch made during a test is recorded here so we can assert on it (or on
// its absence).
interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
let fetchCalls: FetchCall[] = [];

// The behavior a given test wants from the mocked fetch.
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

function setValidEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_FROM_NUMBER = "+15005550006";
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  for (const k of TWILIO_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fetchCalls = [];
  fetchImpl = async () => jsonResponse(201, { sid: "SMdefault" });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    return fetchImpl(String(input), init);
  }) as typeof fetch;
});

afterEach(() => {
  for (const k of TWILIO_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = originalFetch;
});

// ---- Tests ------------------------------------------------------------------

test("missing env vars -> not_configured, no fetch attempted", async () => {
  // env intentionally left unset by beforeEach.
  const result = await sendBookingLinkSms("+15551234567", "hi");
  assert.deepEqual(result, { ok: false, reason: "not_configured" });
  assert.equal(fetchCalls.length, 0);
});

test("empty toNumber -> invalid_input, no fetch attempted", async () => {
  setValidEnv();
  const result = await sendBookingLinkSms("", "hi");
  assert.deepEqual(result, { ok: false, reason: "invalid_input" });
  assert.equal(fetchCalls.length, 0);
});

test("toNumber without leading + -> invalid_input, no fetch attempted", async () => {
  setValidEnv();
  const result = await sendBookingLinkSms("15551234567", "hi");
  assert.deepEqual(result, { ok: false, reason: "invalid_input" });
  assert.equal(fetchCalls.length, 0);
});

test("successful send -> ok:true with the Twilio sid, correct request shape", async () => {
  setValidEnv();
  fetchImpl = async () => jsonResponse(201, { sid: "SM0123456789abcdef" });

  const result = await sendBookingLinkSms("+15551234567", "Your booking link");
  assert.deepEqual(result, { ok: true, sid: "SM0123456789abcdef" });

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.match(
    call.url,
    /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\/Messages\.json$/
  );
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.ok(headers["Authorization"].startsWith("Basic "));
  const sent = new URLSearchParams(String(call.init?.body));
  assert.equal(sent.get("To"), "+15551234567");
  assert.equal(sent.get("From"), "+15005550006");
  assert.equal(sent.get("Body"), "Your booking link");
});

test("non-2xx response -> twilio_error", async () => {
  setValidEnv();
  fetchImpl = async () => jsonResponse(400, { code: 21211, message: "Invalid 'To'" });

  const result = await sendBookingLinkSms("+15551234567", "hi");
  assert.deepEqual(result, { ok: false, reason: "twilio_error" });
  assert.equal(fetchCalls.length, 1);
});

test("2xx without a sid -> twilio_error", async () => {
  setValidEnv();
  fetchImpl = async () => jsonResponse(201, { not_a_sid: true });

  const result = await sendBookingLinkSms("+15551234567", "hi");
  assert.deepEqual(result, { ok: false, reason: "twilio_error" });
});

test("timeout / AbortError -> timeout", async () => {
  setValidEnv();
  fetchImpl = async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  const result = await sendBookingLinkSms("+15551234567", "hi");
  assert.deepEqual(result, { ok: false, reason: "timeout" });
});

test("generic network exception -> twilio_error, never throws", async () => {
  setValidEnv();
  fetchImpl = async () => {
    throw new Error("ECONNRESET");
  };

  const result = await sendBookingLinkSms("+15551234567", "hi");
  assert.deepEqual(result, { ok: false, reason: "twilio_error" });
});

// ---- Log-redaction harness --------------------------------------------------
// A WarnLogger that records every (obj, msg) it is handed, so a test can assert
// on exactly what would be written to the logs. `serialized` flattens all
// recorded entries so a test can assert a sensitive value appears NOWHERE.
interface LogEntry {
  obj: unknown;
  msg?: string;
}
function recordingLogger(): { entries: LogEntry[]; warn: (obj: unknown, msg?: string) => void; serialized(): string } {
  const entries: LogEntry[] = [];
  return {
    entries,
    warn(obj: unknown, msg?: string) {
      entries.push({ obj, msg });
    },
    serialized() {
      return JSON.stringify(entries);
    },
  };
}

const FULL_NUMBER = "15551234567"; // a complete number, used to prove it never leaks
const BOOKING_URL =
  "http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";

test("invalid-input log contains no complete number (masked instead)", async () => {
  setValidEnv();
  const log = recordingLogger();

  const result = await sendBookingLinkSms(FULL_NUMBER, BOOKING_URL, log); // no leading "+"
  assert.deepEqual(result, { ok: false, reason: "invalid_input" });

  const out = log.serialized();
  assert.doesNotMatch(out, new RegExp(FULL_NUMBER), "the complete number must not be logged");
  assert.doesNotMatch(out, /reservit\.com/, "the booking URL/body must not be logged");
  assert.match(out, /\*/, "a masked form should be present");
});

test("Twilio-error log has status + code, never the number or body", async () => {
  setValidEnv();
  // A realistic Twilio 400 whose message echoes the destination number.
  fetchImpl = async () =>
    jsonResponse(400, {
      code: 21211,
      message: `The 'To' number +${FULL_NUMBER} is not a valid phone number.`,
      more_info: "https://www.twilio.com/docs/errors/21211",
    });
  const log = recordingLogger();

  const result = await sendBookingLinkSms(`+${FULL_NUMBER}`, BOOKING_URL, log);
  assert.deepEqual(result, { ok: false, reason: "twilio_error" });

  const out = log.serialized();
  assert.doesNotMatch(out, new RegExp(FULL_NUMBER), "Twilio error body must not leak the number");
  assert.doesNotMatch(out, /is not a valid phone number/, "the raw Twilio message must not be logged");
  assert.doesNotMatch(out, /reservit\.com/, "the booking URL/body must not be logged");
  // Useful category IS preserved.
  assert.match(out, /"status":400/);
  assert.match(out, /"twilioCode":21211/);
});

test("2xx-without-sid log lists field names only, never their values", async () => {
  setValidEnv();
  // Twilio 2xx message resource that (abnormally) lacks a sid; it DOES carry the
  // destination number and our booking-URL body.
  fetchImpl = async () =>
    jsonResponse(201, { to: `+${FULL_NUMBER}`, from: "+15005550006", body: BOOKING_URL });
  const log = recordingLogger();

  const result = await sendBookingLinkSms(`+${FULL_NUMBER}`, BOOKING_URL, log);
  assert.deepEqual(result, { ok: false, reason: "twilio_error" });

  const out = log.serialized();
  assert.doesNotMatch(out, new RegExp(FULL_NUMBER), "the number value must not be logged");
  assert.doesNotMatch(out, /reservit\.com/, "the booking URL/body value must not be logged");
  // Field NAMES are fine (they are not sensitive) and aid debugging.
  assert.match(out, /responseKeys/);
  assert.match(out, /"to"/);
  assert.match(out, /"body"/);
});

test("logs never contain Twilio credentials or authorization values", async () => {
  const authSentinel = "AUTH_TOKEN_SENTINEL_NEVER_LOG";
  const sidSentinel = "ACSIDSENTINELNEVERLOG0000000000000";
  process.env.TWILIO_ACCOUNT_SID = sidSentinel;
  process.env.TWILIO_AUTH_TOKEN = authSentinel;
  process.env.TWILIO_FROM_NUMBER = "+15005550006";

  const log = recordingLogger();

  // Drive the network-failure path (raw error would previously be logged).
  fetchImpl = async () => {
    throw new Error(`connect ECONNREFUSED to https://api.twilio.com/2010-04-01/Accounts/${sidSentinel}/Messages.json`);
  };
  const result = await sendBookingLinkSms(`+${FULL_NUMBER}`, BOOKING_URL, log);
  assert.deepEqual(result, { ok: false, reason: "twilio_error" });

  const out = log.serialized();
  assert.doesNotMatch(out, new RegExp(authSentinel), "auth token must never be logged");
  assert.doesNotMatch(out, new RegExp(sidSentinel), "account SID (in the URL) must never be logged");
  assert.doesNotMatch(out, /Basic /, "the Authorization header value must never be logged");
  // Only the error category is kept.
  assert.match(out, /"errName":"Error"/);
});

test("successful send logs nothing sensitive (no number, body, or sid leak)", async () => {
  setValidEnv();
  fetchImpl = async () => jsonResponse(201, { sid: "SMok" });
  const log = recordingLogger();

  const result = await sendBookingLinkSms(`+${FULL_NUMBER}`, BOOKING_URL, log);
  assert.deepEqual(result, { ok: true, sid: "SMok" });
  // Happy path warns about nothing.
  assert.equal(log.entries.length, 0);
});

test("TWILIO_FAIL_SAFE is never read, even when set", async () => {
  setValidEnv();
  const sentinel = "FAIL_SAFE_SENTINEL_SHOULD_NEVER_APPEAR";
  process.env.TWILIO_FAIL_SAFE = sentinel;
  fetchImpl = async () => jsonResponse(201, { sid: "SMok" });

  const result = await sendBookingLinkSms("+15551234567", "hi");
  assert.deepEqual(result, { ok: true, sid: "SMok" });

  // The sentinel must not leak into the URL, headers, or body of the request.
  const call = fetchCalls[0];
  const serialized =
    call.url + JSON.stringify(call.init?.headers) + String(call.init?.body);
  assert.doesNotMatch(serialized, new RegExp(sentinel));
});
