/**
 * Send the booking-link SMS via Twilio's REST API.
 *
 * Standalone and pure: not wired into any route yet. Reads its Twilio
 * credentials from the environment INSIDE the function (same fail-closed pattern
 * as mailer.ts / sheets.ts), calls Twilio's Messages API directly with native
 * fetch (no SDK dependency), and never throws to its caller — every failure mode
 * is reported as a discriminated result so the caller can fall back to
 * "please call us" without a try/catch.
 */

// Per-request timeout, mirroring availability.ts's checkNight (an SMS send must
// never stall the guest-facing turn).
const TWILIO_TIMEOUT_MS = 4000;

export type SmsResult =
  | { ok: true; sid: string }
  | { ok: false; reason: "not_configured" | "invalid_input" | "timeout" | "twilio_error" };

interface WarnLogger {
  warn: (obj: unknown, msg?: string) => void;
}

function warn(logger: WarnLogger | undefined, obj: unknown, msg: string): void {
  if (logger) {
    logger.warn(obj, msg);
  } else {
    console.warn(msg, obj);
  }
}

export async function sendBookingLinkSms(
  toNumber: string,
  body: string,
  logger?: WarnLogger
): Promise<SmsResult> {
  // 1. Credentials — read here, not at module scope, so importing this module
  // never requires Twilio to be configured (keeps it unit-testable). We never
  // reference TWILIO_FAIL_SAFE: it is an unrelated account-recovery key.
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) {
    warn(logger, {}, "TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER not set — skipping SMS");
    return { ok: false, reason: "not_configured" };
  }

  // 2. Validate the destination. Must be E.164 (starts with "+"); we never guess
  // or add a country code — reject cleanly and let the caller fall back.
  if (typeof toNumber !== "string" || !toNumber.startsWith("+")) {
    warn(logger, { toNumber }, "sms: invalid destination number (must be E.164)");
    return { ok: false, reason: "invalid_input" };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const form = new URLSearchParams({ To: toNumber, From: fromNumber, Body: body });

  // 3-4. Send, bounded by a timeout via AbortController (mirrors availability.ts,
  // including the try/finally clearTimeout).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: controller.signal,
    });

    // 5. Non-2xx: log status + body and report a generic failure.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(logger, { status: res.status, body: text }, "sms: Twilio responded non-2xx");
      return { ok: false, reason: "twilio_error" };
    }

    const data = (await res.json()) as { sid?: unknown };
    const sid = data?.sid;
    if (typeof sid !== "string" || sid.length === 0) {
      warn(logger, { data }, "sms: Twilio 2xx without a message sid");
      return { ok: false, reason: "twilio_error" };
    }

    return { ok: true, sid };
  } catch (err) {
    // 4/6. Timeout aborts surface as an AbortError; everything else is a generic
    // network/twilio failure. Either way we never throw to the caller.
    if (err instanceof Error && err.name === "AbortError") {
      warn(logger, { err }, "sms: Twilio request timed out");
      return { ok: false, reason: "timeout" };
    }
    warn(logger, { err }, "sms: Twilio request failed");
    return { ok: false, reason: "twilio_error" };
  } finally {
    clearTimeout(timeout);
  }
}
