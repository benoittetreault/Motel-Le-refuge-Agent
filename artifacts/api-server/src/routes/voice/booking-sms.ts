// Voice booking-link SMS orchestration (Bloc B + Bloc C).
//
// This is the ONE place that decides, for a link-bearing voice turn, whether we
// text the guest the booking link and what we then say out loud. It is kept out
// of the HTTP route so the whole decision tree is unit-testable with injected
// fakes (no server, no Reservit, no Twilio, no API key).
//
// Design contract — the assistant must NEVER speak "I've texted you the link"
// unless an SMS was actually sent successfully. Every branch below returns a
// spoken reply that is EITHER the success confirmation (only after ok:true, or a
// confirmed earlier send this call) OR the invite-to-call fallback. A booking
// URL is never part of the spoken reply in any branch.
//
// Responsibility separation is preserved: availability lives in availability.ts,
// link parsing in reservit-link.ts, phone resolution + spoken wording in
// concierge.ts, duplicate protection in sent-link-store.ts, and the Twilio call
// in lib/sms.ts. This module only sequences them.

import type { AvailabilityResult } from "../anthropic/availability";
import { parseReservitParams } from "../anthropic/reservit-link";
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

export interface BookingSmsInput {
  /** Every Reservit link found in the model's candidate reply (>= 1). */
  links: string[];
  /** Vapi call id — the dedup scope. May be undefined on a malformed payload. */
  callId: string | undefined;
  /** The caller's own number from verified call metadata (call.customer.number). */
  callerNumber: string | undefined;
  /** The mapped conversation, scanned for a DTMF keypad number if metadata has none. */
  messages: ChatMessageList;
  /** Motel identity used for the SMS body and the invite-to-call wording. */
  motelName: string;
  spokenOpts: SpokenReplyOpts;
}

// Machine-readable outcome for structured logging. No secrets, no phone numbers,
// no URLs — safe to log as-is.
export type BookingSmsStatus =
  | "sent" // SMS sent this turn.
  | "duplicate" // already sent earlier this call; no second SMS.
  | "not_available" // server re-check says the dates are not bookable.
  | "no_number" // no verified/keyed guest number to text.
  | "send_failed"; // Twilio (or config) failure.

export interface BookingSmsOutcome {
  /** The safe, code-authored text to speak. Never contains a URL. */
  reply: string;
  status: BookingSmsStatus;
  /** Present only when status === "send_failed": the SmsResult reason. */
  smsReason?: Extract<SmsResult, { ok: false }>["reason"];
}

// Stable dedup key for a set of links: the same link-set (in any order) maps to
// the same key, so re-emitting the same booking on a later turn is recognized.
function dedupKey(links: string[]): string {
  return [...links].sort().join("|");
}

// The SMS body: a short bilingual line plus the link(s), one per line. This is
// the ONLY place a URL is emitted, and it goes to Twilio, never to TTS.
function buildSmsBody(links: string[], motelName: string): string {
  return (
    `${motelName} — voici votre lien de réservation / here is your booking link:\n` +
    links.join("\n")
  );
}

// A link is bookable if the server re-check says all_available, OR if we simply
// could not verify it (check_failed = Reservit unreachable, or the link's params
// were unparseable). Mirrors the web route: an inability to verify never blocks
// the guest, but a definitive not/partial/too_long does.
function isHardFailure(result: AvailabilityResult): boolean {
  return result.status !== "all_available" && result.status !== "check_failed";
}

export async function orchestrateBookingSms(
  input: BookingSmsInput,
  deps: BookingSmsDeps
): Promise<BookingSmsOutcome> {
  const { links, callId, callerNumber, messages, motelName, spokenOpts } = input;
  const key = dedupKey(links);

  // 1. Duplicate guard FIRST — a repeated turn short-circuits before we touch
  //    Reservit or Twilio again. We already texted the link this call, so the
  //    truthful thing to say is the same success confirmation, no second SMS.
  if (callId && deps.store.alreadySent(callId, key)) {
    return { reply: smsSentReply(), status: "duplicate" };
  }

  // 2. Server-side availability re-verification. Parse each link; verify the
  //    parseable ones. Only a definitive failure blocks the send.
  const parsed = links
    .map((link) => parseReservitParams(link))
    .filter((p): p is NonNullable<typeof p> => p !== null);

  if (parsed.length > 0) {
    const results = await Promise.all(
      parsed.map((p) => deps.checkAvailability(p.arrivalDate, p.nights, p.adults))
    );
    if (results.some(isHardFailure)) {
      return { reply: inviteToCallReply(spokenOpts), status: "not_available" };
    }
  }

  // 3. Resolve the guest's number (verified metadata, then DTMF keypad). Without
  //    one we cannot text anything — fall back to invite-to-call, never claim a
  //    send.
  const toNumber = resolveGuestPhone(callerNumber, messages);
  if (!toNumber) {
    return { reply: inviteToCallReply(spokenOpts), status: "no_number" };
  }

  // 4. Send. sendSms never throws — it returns a discriminated result.
  const result = await deps.sendSms(toNumber, buildSmsBody(links, motelName));
  if (result.ok) {
    // Record the successful send so later turns dedup instead of re-texting.
    if (callId) deps.store.markSent(callId, key);
    return { reply: smsSentReply(), status: "sent" };
  }

  // 5. Any failure (not_configured / invalid_input / timeout / twilio_error):
  //    do NOT mark sent (so a later turn may retry) and do NOT claim success.
  return { reply: inviteToCallReply(spokenOpts), status: "send_failed", smsReason: result.reason };
}
