// Call-scoped "pending booking" store for the voice channel.
//
// When a stay is available but we have no number yet (a browser webCall, or a
// caller who hasn't keyed a callback number), we ask the guest to enter a number
// on the keypad. The booking link must then be sent on a LATER turn — but we
// cannot rely on the model to deterministically re-emit the exact same booking
// link. So we remember, per call, the already-VALIDATED, server-built booking so
// the keypad-continuation turn can send it directly.
//
// SECURITY: this stores ONLY non-sensitive booking facts — the validated params,
// the canonical server-built URL(s), and the availability state. It never stores
// transcripts, phone numbers, tokens, or any secret. Entries self-expire (TTL)
// and are single-process (see sent-link-store.ts for the same scope caveat).

import type { ReservitBooking } from "../anthropic/reservit-link";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min — a call plus a little slack.

/** Whether the stored booking was server-verified available or merely unverified. */
export type PendingAvailability = "available" | "unverified";

export interface PendingBooking {
  /** Validated booking params (arrivalDate/nights/adults + date parts + lang). */
  bookings: ReservitBooking[];
  /** Canonical, server-built booking URL(s) — safe to text as-is. */
  canonicalUrls: string[];
  /** The dedup key for these URLs (matches sent-link-store keys). */
  key: string;
  /** all_available → "available"; check_failed (unreachable) → "unverified". */
  availability: PendingAvailability;
}

export interface PendingBookingStore {
  /** The current pending booking for a call, or undefined (none / expired). */
  get(callId: string): PendingBooking | undefined;
  /** Remember (or replace) the pending booking for a call; refreshes its TTL. */
  set(callId: string, booking: PendingBooking): void;
  /** Forget the pending booking for a call (after a successful send, or when unavailable). */
  clear(callId: string): void;
}

export function createPendingBookingStore(
  ttlMs: number = DEFAULT_TTL_MS,
  now: () => number = Date.now
): PendingBookingStore {
  const store = new Map<string, { booking: PendingBooking; expiry: number }>();

  const prune = (t: number): void => {
    for (const [k, v] of store) {
      if (v.expiry <= t) store.delete(k);
    }
  };

  return {
    get(callId: string): PendingBooking | undefined {
      const t = now();
      prune(t);
      const entry = store.get(callId);
      return entry && entry.expiry > t ? entry.booking : undefined;
    },
    set(callId: string, booking: PendingBooking): void {
      const t = now();
      prune(t);
      store.set(callId, { booking, expiry: t + ttlMs });
    },
    clear(callId: string): void {
      store.delete(callId);
    },
  };
}

// Process-wide singleton for the live voice route. Tests inject their own.
export const pendingBookingStore = createPendingBookingStore();
