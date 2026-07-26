// Voice booking-link SMS orchestration (Bloc B + Bloc C).
//
// This is the ONE place that decides, for a link-bearing voice turn, whether we
// text the guest the booking link and what we then say out loud. It is kept out
// of the HTTP route so the whole decision tree is unit-testable with injected
// fakes (no server, no Reservit, no Twilio, no API key).
//
// Safety contract:
//  - The assistant must NEVER speak "I've texted you the link" unless an SMS was
//    actually sent successfully. Every branch returns either the success
//    confirmation (only after ok:true, or a confirmed earlier send this call) or
//    the invite-to-call fallback. A booking URL is never in the spoken reply.
//  - We NEVER text a model-supplied URL. Each link is strictly validated against
//    our own hotel id and rebuilt server-side from trusted config, so a bad
//    host, path, hotelid, or extra query parameter can never reach the guest.
//  - Sending is guarded by an atomic per-call claim so concurrent/duplicate
//    turns cannot send the same booking twice (within one process — see store).
//
// Responsibility separation: availability lives in availability.ts, link
// validation + construction in reservit-link.ts, phone resolution + spoken
// wording in concierge.ts, duplicate/claim protection in sent-link-store.ts, and
// the Twilio call in lib/sms.ts. This module only sequences them.

import type { AvailabilityResult } from "../anthropic/availability";
import {
  parseAndValidateReservitLink,
  buildReservitLink,
  type ReservitBooking,
} from "../anthropic/reservit-link";
import type { SmsResult } from "../../lib/sms";
import type { ChatMessageList } from "../anthropic/chat-brain";
import type { SentLinkStore } from "./sent-link-store";
import { inviteToCallReply, smsSentReply, resolveGuestPhone, type SpokenReplyOpts } from "./concierge";

// Injected side-effecting dependencies. The route passes the real
// checkAvailability / sendBookingLinkSms / singleton store; tests pass fakes.
export interface BookingSmsDeps {
  checkAvailability: (arrivalDate: string, nights: number, adults: number) => Promise<AvailabilityResult>;
  sendSms: (to: string, body: string) => Promise<SmsResult>;
  store: SentLinkStore;
}

/** Trusted, server-side booking config used to rebuild the canonical link. */
export interface BookingConfig {
  hotelId: string;
  linkBase: string;
}

export interface BookingSmsInput {
  /** Every Reservit link found in the model's candidate reply (>= 1). UNTRUSTED. */
  links: string[];
  /** Vapi call id — REQUIRED for the idempotency claim. */
  callId: string | undefined;
  /** The caller's own number from verified call metadata (call.customer.number). */
  callerNumber: string | undefined;
  /** The mapped conversation, scanned for a DTMF keypad number if metadata has none. */
  messages: ChatMessageList;
  /** Motel identity used for the SMS body and the invite-to-call wording. */
  motelName: string;
  /** Trusted booking config (hotel id + link base) for server-side rebuilding. */
  bookingConfig: BookingConfig;
  spokenOpts: SpokenReplyOpts;
}

// Machine-readable outcome for structured logging. No secrets, no phone numbers,
// no URLs — safe to log as-is.
export type BookingSmsStatus =
  | "sent" // SMS sent this turn.
  | "duplicate" // already sent earlier this call; no second SMS.
  | "in_flight" // a concurrent turn is already sending; this turn does not send.
  | "not_available" // server re-check says the dates are not bookable.
  | "invalid_link" // a link failed strict validation (bad host/path/hotelid/params).
  | "missing_call_id" // no stable call id → cannot dedup, so we do not send.
  | "no_number" // no verified/keyed guest number to text.
  | "send_failed"; // Twilio (or config) failure.

export interface BookingSmsOutcome {
  /** The safe, code-authored text to speak. Never contains a URL. */
  reply: string;
  status: BookingSmsStatus;
  /** Present only when status === "send_failed": the SmsResult reason. */
  smsReason?: Extract<SmsResult, { ok: false }>["reason"];
}

// Canonical, collision-proof dedup key for a set of validated booking URLs.
// JSON.stringify of the sorted array is unambiguous — quoting/escaping means no
// delimiter character inside a URL can forge a different array's key.
function dedupKey(canonicalUrls: string[]): string {
  return JSON.stringify([...canonicalUrls].sort());
}

// The SMS body: a short bilingual line plus the canonical link(s), one per line.
// This is the ONLY place a URL is emitted, and it goes to Twilio, never to TTS.
function buildSmsBody(urls: string[], motelName: string): string {
  return (
    `${motelName} — voici votre lien de réservation / here is your booking link:\n` +
    urls.join("\n")
  );
}

// A booking is bookable if the server re-check says all_available, OR if we
// simply could NOT reach Reservit (check_failed). A definitive negative
// (none_available / partial / too_long) blocks the send. Note: check_failed is
// "could not verify", never "verified" — we do not claim verification when
// Reservit was unreachable; the booking page shows live availability.
function isDefinitiveFailure(result: AvailabilityResult): boolean {
  return result.status !== "all_available" && result.status !== "check_failed";
}

export async function orchestrateBookingSms(
  input: BookingSmsInput,
  deps: BookingSmsDeps
): Promise<BookingSmsOutcome> {
  const { links, callId, callerNumber, messages, motelName, bookingConfig, spokenOpts } = input;
  const invite = (status: BookingSmsStatus, smsReason?: BookingSmsOutcome["smsReason"]): BookingSmsOutcome => ({
    reply: inviteToCallReply(spokenOpts),
    status,
    smsReason,
  });

  // 0. Idempotency requires a stable call id. Without one we cannot safely dedup
  //    across repeated/malformed turns, so we do NOT send.
  if (!callId) return invite("missing_call_id");

  // 1. Strictly validate EVERY link against our hotel id, then rebuild each URL
  //    server-side from trusted config. Any invalid link rejects the whole turn
  //    (never text a partially-trusted set).
  const bookings: ReservitBooking[] = [];
  for (const link of links) {
    const booking = parseAndValidateReservitLink(link, bookingConfig.hotelId);
    if (!booking) return invite("invalid_link");
    bookings.push(booking);
  }
  const canonicalUrls = bookings.map((b) =>
    buildReservitLink(bookingConfig.linkBase, bookingConfig.hotelId, b)
  );
  const key = dedupKey(canonicalUrls);

  // 2. Atomic claim BEFORE any await — this is the concurrency gate.
  const claim = deps.store.claim(callId, key);
  if (claim === "already_sent") {
    return { reply: smsSentReply(), status: "duplicate" };
  }
  if (claim === "in_flight") {
    // Another turn is sending this exact booking right now. We must not send,
    // and we must not falsely claim it was sent from THIS turn.
    return invite("in_flight");
  }

  // We now hold the claim. From here, every non-success path must release it so
  // a later turn can retry.
  try {
    // 3. Server-side availability re-verification (validated params). Only a
    //    definitive negative blocks.
    const results = await Promise.all(
      bookings.map((b) => deps.checkAvailability(b.arrivalDate, b.nights, b.adults))
    );
    if (results.some(isDefinitiveFailure)) {
      deps.store.release(callId, key);
      return invite("not_available");
    }

    // 4. Resolve the guest's number (verified metadata, then DTMF keypad).
    const toNumber = resolveGuestPhone(callerNumber, messages);
    if (!toNumber) {
      deps.store.release(callId, key);
      return invite("no_number");
    }

    // 5. Send the canonical (server-built) link(s). sendSms never throws.
    const result = await deps.sendSms(toNumber, buildSmsBody(canonicalUrls, motelName));
    if (result.ok) {
      deps.store.markSent(callId, key);
      return { reply: smsSentReply(), status: "sent" };
    }

    // Failure: release so a later turn may retry; never claim success.
    deps.store.release(callId, key);
    return invite("send_failed", result.reason);
  } catch (err) {
    // Defensive: nothing above is expected to throw (checkAvailability fails
    // closed to check_failed, sendSms is total), but if anything does, release
    // the claim so the call is not permanently wedged, and fall back safely.
    deps.store.release(callId, key);
    throw err;
  }
}
