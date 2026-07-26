// Duplicate-SMS protection for the voice channel.
//
// Vapi replays the FULL conversation on every turn, so once the model has
// emitted a booking link it will very likely re-emit it on subsequent turns.
// Without a guard we would text the guest the same link once per turn. This
// store remembers, per call, which link-sets we have already successfully sent,
// so a repeated turn (or a webhook retry) speaks the confirmation again WITHOUT
// firing a second SMS.
//
// Scope is intentionally small and process-local: a phone call is short-lived
// and handled by a single server instance, so an in-memory map with a TTL is
// sufficient and needs no external store. Entries self-expire so a long-running
// process never leaks memory across thousands of calls.

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — comfortably longer than any call.

export interface SentLinkStore {
  /** True if (callId, key) was already marked sent and has not expired. */
  alreadySent(callId: string, key: string): boolean;
  /** Record that (callId, key) has been sent; refreshes its expiry. */
  markSent(callId: string, key: string): void;
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
  // Map<compositeKey, expiryEpochMs>.
  const seen = new Map<string, number>();

  // Drop every expired entry. Called on each access — cheap for the handful of
  // entries a single process accumulates, and keeps the map from growing
  // unbounded over a long-lived process.
  function prune(t: number): void {
    for (const [k, expiry] of seen) {
      if (expiry <= t) seen.delete(k);
    }
  }

  return {
    alreadySent(callId: string, key: string): boolean {
      const t = now();
      prune(t);
      const expiry = seen.get(composite(callId, key));
      return expiry !== undefined && expiry > t;
    },
    markSent(callId: string, key: string): void {
      const t = now();
      prune(t);
      seen.set(composite(callId, key), t + ttlMs);
    },
  };
}

// Process-wide singleton for the live voice route. Tests inject their own.
export const sentLinkStore = createSentLinkStore();
