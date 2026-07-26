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

import { maskPhone } from "./redact";

// Per-request timeout, mirroring availability.ts's checkNight (an SMS send must
// never stall the guest-facing turn).
const TWILIO_TIMEOUT_MS = 4000;

// Pull ONLY Twilio's numeric error code out of a non-2xx response body, dropping
// everything else. Twilio error bodies (`{ code, message, more_info, ... }`)
// routinely echo the destination number inside `message`/`more_info`, so we must
// never log the raw body — the code alone preserves the useful error category.
function twilioErrorCode(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

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
  logger?: WarnLogger,
  externalSignal?: AbortSignal
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

  // 2. Validate the destination as strict E.164: "+", a leading non-zero
  // country-code digit, then 7–14 more digits (8–15 total, the ITU maximum). We
  // never guess or add a country code — reject cleanly and let the caller fall
  // back. This is the provider boundary, so the check is authoritative here even
  // though callers pre-validate.
  if (typeof toNumber !== "string" || !/^\+[1-9]\d{7,14}$/.test(toNumber)) {
    // Log a MASKED form only — never the complete destination number.
    warn(logger, { toNumber: maskPhone(toNumber) }, "sms: invalid destination number (must be E.164)");
    return { ok: false, reason: "invalid_input" };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const form = new URLSearchParams({ To: toNumber, From: fromNumber, Body: body });

  // 3-4. Send, bounded by a timeout via AbortController (mirrors availability.ts,
  // including the try/finally clearTimeout). An optional externalSignal (the voice
  // deadline) can abort the in-flight send too, so a late request never completes
  // after the guest has already heard the fallback.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS);
  const signal =
    externalSignal !== undefined
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal,
    });

    // 5. Non-2xx: log the HTTP status and Twilio's numeric error CODE only — the
    // raw body echoes the destination number, so it is never logged.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      warn(
        logger,
        { status: res.status, twilioCode: twilioErrorCode(text) },
        "sms: Twilio responded non-2xx"
      );
      return { ok: false, reason: "twilio_error" };
    }

    const data = (await res.json()) as { sid?: unknown };
    const sid = data?.sid;
    if (typeof sid !== "string" || sid.length === 0) {
      // A 2xx Twilio message resource carries `to`, `from`, and `body` (our
      // booking URL). Log only the field NAMES present, never their values.
      const keys = data && typeof data === "object" ? Object.keys(data) : [];
      warn(logger, { responseKeys: keys }, "sms: Twilio 2xx without a message sid");
      return { ok: false, reason: "twilio_error" };
    }

    return { ok: true, sid };
  } catch (err) {
    // 4/6. Timeout aborts surface as an AbortError; everything else is a generic
    // network/twilio failure. Either way we never throw to the caller. We log
    // only the error's NAME (a category) — never the raw error, whose message or
    // stack could carry the request URL (which contains the account SID).
    const errName = err instanceof Error ? err.name : "unknown";
    if (err instanceof Error && err.name === "AbortError") {
      warn(logger, { errName }, "sms: Twilio request timed out");
      return { ok: false, reason: "timeout" };
    }
    warn(logger, { errName }, "sms: Twilio request failed");
    return { ok: false, reason: "twilio_error" };
  } finally {
    clearTimeout(timeout);
  }
}
