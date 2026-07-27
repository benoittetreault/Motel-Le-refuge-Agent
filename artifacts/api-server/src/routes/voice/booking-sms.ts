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
import type { PendingBookingStore, PendingAvailability } from "./pending-booking-store";
import type { DeadlineView } from "./deadline";
import {
  inviteToCallReply,
  smsSentReply,
  availableNeedsNumberReply,
  unavailableReply,
  resolveGuestPhone,
  type SpokenReplyOpts,
} from "./concierge";

// Minimum time we insist on having left before STARTING a Twilio send: the
// provider call itself is bounded at ~4s, so if less than this remains we would
// risk finishing (and confirming) after the voice deadline. In that case we do
// not send at all and invite the guest to call — never a send we can't confirm
// in time, never a false claim.
const SMS_MIN_BUDGET_MS = 4500;

// Injected side-effecting dependencies. The route passes the real
// checkAvailability / sendBookingLinkSms / singleton stores; tests pass fakes.
export interface BookingSmsDeps {
  checkAvailability: (arrivalDate: string, nights: number, adults: number) => Promise<AvailabilityResult>;
  sendSms: (to: string, body: string) => Promise<SmsResult>;
  store: SentLinkStore;
  /** Remembers an available booking awaiting a keypad number (continuation). */
  pendingStore: PendingBookingStore;
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
  /**
   * Optional voice processing deadline. When present, we refuse to START an SMS
   * send that cannot finish and be confirmed before it — so a late send never
   * fires after the guest has already heard the fallback.
   */
  deadline?: DeadlineView;
}

// Machine-readable outcome for structured logging. No secrets, no phone numbers,
// no URLs — safe to log as-is.
export type BookingSmsStatus =
  | "available_sent" // available AND the SMS was sent this turn.
  | "available_needs_number" // available, but no number yet — asked for keypad entry.
  | "unavailable" // server re-check says the dates are not bookable.
  | "duplicate" // already sent earlier this call; no second SMS.
  | "in_flight" // a concurrent turn is already sending; this turn does not send.
  | "invalid_link" // a link failed strict validation (bad host/path/hotelid/params).
  | "missing_call_id" // no stable call id → cannot dedup, so we do not send.
  | "send_failed" // Twilio (or config) failure.
  | "timed_out" // not enough time left to safely send before the voice deadline.
  | "no_booking"; // no link this turn and no pending booking — route speaks the model reply.

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
// (none_available / partial / too_long) blocks. Note: check_failed is "could not
// verify", never "verified" — the booking page shows live availability.
function isDefinitiveFailure(result: AvailabilityResult): boolean {
  return result.status !== "all_available" && result.status !== "check_failed";
}

/** Validate + rebuild the current turn's model links into canonical bookings. */
function buildFromLinks(
  links: string[],
  bookingConfig: BookingConfig
): { bookings: ReservitBooking[]; canonicalUrls: string[] } | null {
  const bookings: ReservitBooking[] = [];
  for (const link of links) {
    const booking = parseAndValidateReservitLink(link, bookingConfig.hotelId);
    if (!booking) return null; // any invalid link rejects the whole turn
    bookings.push(booking);
  }
  const canonicalUrls = bookings.map((b) =>
    buildReservitLink(bookingConfig.linkBase, bookingConfig.hotelId, b)
  );
  return { bookings, canonicalUrls };
}

/**
 * Decide, for a booking-relevant voice turn, what to do and what to say. The
 * booking to act on comes from EITHER the model's freshly-emitted link(s) (which
 * are strictly validated + rebuilt server-side) OR a pending booking remembered
 * from an earlier "available, please key your number" turn. Availability is
 * ALWAYS checked (even with no number) so the result can be stated to the guest;
 * a stay is only ever texted after a successful Twilio send.
 */
export async function orchestrateBookingSms(
  input: BookingSmsInput,
  deps: BookingSmsDeps
): Promise<BookingSmsOutcome> {
  const { links, callId, callerNumber, messages, motelName, bookingConfig, spokenOpts, deadline } = input;
  const invite = (status: BookingSmsStatus, smsReason?: BookingSmsOutcome["smsReason"]): BookingSmsOutcome => ({
    reply: inviteToCallReply(spokenOpts),
    status,
    smsReason,
  });

  // 0. Idempotency requires a stable call id.
  if (!callId) return invite("missing_call_id");

  // 1. Resolve the booking source. Fresh model link(s) take precedence; otherwise
  //    fall back to a pending booking (keypad-continuation turn). If neither, this
  //    is a normal conversational turn — the route speaks the model's reply.
  let bookings: ReservitBooking[];
  let canonicalUrls: string[];
  if (links.length > 0) {
    const built = buildFromLinks(links, bookingConfig);
    if (!built) return invite("invalid_link");
    ({ bookings, canonicalUrls } = built);
  } else {
    const pending = deps.pendingStore.get(callId);
    if (!pending) return { reply: "", status: "no_booking" };
    ({ bookings, canonicalUrls } = pending);
  }
  const key = dedupKey(canonicalUrls);

  // 2. Atomic claim BEFORE any await — the concurrency gate.
  const claim = deps.store.claim(callId, key);
  if (claim === "already_sent") return { reply: smsSentReply(), status: "duplicate" };
  if (claim === "in_flight") return invite("in_flight");

  // We hold the claim; every non-success path must release it so a later turn can
  // retry. Pending is set only when we still owe the guest a send.
  try {
    // 3. Server-side availability re-verification (validated params, memoized per
    //    request so dates already checked in the model loop aren't re-fetched).
    const results = await Promise.all(
      bookings.map((b) => deps.checkAvailability(b.arrivalDate, b.nights, b.adults))
    );
    if (results.some(isDefinitiveFailure)) {
      deps.store.release(callId, key);
      deps.pendingStore.clear(callId); // the offer is no longer valid
      return { reply: unavailableReply(spokenOpts), status: "unavailable" };
    }
    const availability: PendingAvailability = results.every((r) => r.status === "all_available")
      ? "available"
      : "unverified";
    const pendingSnapshot = { bookings, canonicalUrls, key, availability };

    // 4. Resolve the guest's number (verified metadata → DTMF keypad). If none,
    //    the stay IS available but we can't text yet: state availability and ask
    //    for a keypad number, remembering the booking for the continuation turn.
    const toNumber = resolveGuestPhone(callerNumber, messages);
    if (!toNumber) {
      deps.store.release(callId, key);
      deps.pendingStore.set(callId, pendingSnapshot);
      return { reply: availableNeedsNumberReply(), status: "available_needs_number" };
    }

    // 5. Deadline check — never START a send we can't finish and confirm before
    //    the voice deadline. Keep the pending booking so the next turn can retry.
    if (deadline && (deadline.expired() || deadline.remainingMs() < SMS_MIN_BUDGET_MS)) {
      deps.store.release(callId, key);
      deps.pendingStore.set(callId, pendingSnapshot);
      return invite("timed_out");
    }

    // 6. Send the canonical (server-built) link(s). sendSms never throws.
    const result = await deps.sendSms(toNumber, buildSmsBody(canonicalUrls, motelName));
    if (result.ok) {
      deps.store.markSent(callId, key);
      deps.pendingStore.clear(callId);
      return { reply: smsSentReply(), status: "available_sent" };
    }

    // Failure: release + keep pending so a later turn may retry; never claim success.
    deps.store.release(callId, key);
    deps.pendingStore.set(callId, pendingSnapshot);
    return invite("send_failed", result.reason);
  } catch (err) {
    // Defensive: nothing above is expected to throw (checkAvailability fails
    // closed, sendSms is total), but if anything does, release the claim so the
    // call is not permanently wedged, and let the route fall back safely.
    deps.store.release(callId, key);
    throw err;
  }
}
