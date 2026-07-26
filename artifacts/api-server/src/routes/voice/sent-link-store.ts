// Duplicate-SMS protection for the voice channel — concurrency-safe.
//
// Vapi replays the FULL conversation on every turn, so once the model has
// emitted a booking link it will very likely re-emit it on subsequent turns;
// Vapi (or a webhook) can also deliver two turns for the same booking almost
// simultaneously. Without a guard we would text the guest the same link more
// than once.
//
// This store is a small state machine per (callId, bookingKey):
//   not-claimed → (claim) → in-flight → (markSent)  → sent
//                                    └→ (release)   → not-claimed  (retryable)
//
// `claim` is the atomic gate. Because JavaScript runs this synchronous method to
// completion with no interleaving, two concurrent turns cannot both receive
// "claimed": the first flips the entry to in-flight before the second's claim
// runs, so the second sees "in_flight" and must NOT send. The winner sends, then
// calls markSent (→ sent) on success or release (→ not-claimed) on failure so a
// later turn may retry. A duplicate turn after success sees "already_sent".
//
// SCOPE — SINGLE PROCESS ONLY. This map lives in one Node process's memory. It
// gives NO cross-instance idempotency: if the API ever runs more than one
// instance behind a load balancer, two instances could each send once. Cross-
// instance safety would require a shared store (Redis) or a DB uniqueness
// constraint. See the deployment note in the checkpoint doc.

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — comfortably longer than any call.

/** Result of an atomic claim attempt. */
export type ClaimResult =
  | "claimed" // caller now owns the send for this (callId, key).
  | "in_flight" // another turn is sending right now — caller must not send.
  | "already_sent"; // a previous turn already sent — caller must not send again.

export interface SentLinkStore {
  /** Atomically attempt to claim (callId, key) for sending. */
  claim(callId: string, key: string): ClaimResult;
  /** Transition a claim to "sent" (call after a successful send). */
  markSent(callId: string, key: string): void;
  /** Release a claim so a later turn can retry (call after a failed send). */
  release(callId: string, key: string): void;
}

type EntryState = "in_flight" | "sent";
interface Entry {
  state: EntryState;
  /** Epoch ms after which this entry is considered expired. */
  expiry: number;
}

// Length-prefix the callId so the boundary is unambiguous: no pair of
// (callId, key) values can collide with a different pair, whatever characters
// they contain (a bare space separator would let "a b"/"c" collide with
// "a"/"b c").
function composite(callId: string, key: string): string {
  return `${callId.length}:${callId}:${key}`;
}

/**
 * Create an isolated store. The route uses one module-level singleton; tests
 * create their own so state never leaks between cases.
 *
 * `now` is injectable so TTL expiry can be tested without real time passing.
 */
export function createSentLinkStore(
  ttlMs: number = DEFAULT_TTL_MS,
  now: () => number = Date.now
): SentLinkStore {
  const seen = new Map<string, Entry>();

  // Drop every expired entry. Called on each access — cheap for the handful of
  // entries a single process accumulates, and keeps the map from growing
  // unbounded over a long-lived process.
  function prune(t: number): void {
    for (const [k, entry] of seen) {
      if (entry.expiry <= t) seen.delete(k);
    }
  }

  return {
    claim(callId: string, key: string): ClaimResult {
      const t = now();
      prune(t);
      const k = composite(callId, key);
      const entry = seen.get(k);
      if (entry && entry.expiry > t) {
        return entry.state === "sent" ? "already_sent" : "in_flight";
      }
      // Not claimed (or expired) → take the claim atomically.
      seen.set(k, { state: "in_flight", expiry: t + ttlMs });
      return "claimed";
    },
    markSent(callId: string, key: string): void {
      const t = now();
      prune(t);
      seen.set(composite(callId, key), { state: "sent", expiry: t + ttlMs });
    },
    release(callId: string, key: string): void {
      // Only drop a still-in-flight claim; never un-send a completed "sent".
      const k = composite(callId, key);
      const entry = seen.get(k);
      if (entry && entry.state === "in_flight") seen.delete(k);
    },
  };
}

// Process-wide singleton for the live voice route. Tests inject their own.
export const sentLinkStore = createSentLinkStore();
