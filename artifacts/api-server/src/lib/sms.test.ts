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
