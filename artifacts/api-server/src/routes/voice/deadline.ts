// Voice processing deadline.
//
// Vapi abandons a Custom-LLM turn at ~20s (providerfault-model-no-response). We
// therefore cap our own processing well under that: if we cannot finish in time
// we stop waiting and speak a short, safe fallback (invite-to-call) instead of
// letting Vapi time out with silence. Crucially the deadline must never cause us
// to claim availability or claim an SMS — the fallback only ever invites a call.
//
// Two views are exposed:
//  - VoiceDeadline: the full object the route owns (abort signal + clear()).
//  - DeadlineView: the read-only slice the SMS orchestrator consumes to decide
//    whether there is still time to safely send (so a send is never started that
//    cannot complete and be confirmed before the deadline).

/** Read-only deadline view for code that must decide "is there still time?". */
export interface DeadlineView {
  /** True once the deadline has passed (or its signal aborted). */
  expired(): boolean;
  /** Milliseconds left before the deadline (never negative). */
  remainingMs(): number;
}

export interface VoiceDeadline extends DeadlineView {
  /** Aborts when the deadline fires — thread into fetch()/provider calls. */
  signal: AbortSignal;
  /** Clear the underlying timer (call in a finally to avoid a dangling timer). */
  clear(): void;
}

export function createVoiceDeadline(ms: number, now: () => number = Date.now): VoiceDeadline {
  const controller = new AbortController();
  const end = now() + ms;
  const timer = setTimeout(() => controller.abort(), ms);
  // Don't keep the event loop alive just for this timer.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  return {
    signal: controller.signal,
    expired: () => controller.signal.aborted || now() >= end,
    remainingMs: () => Math.max(0, end - now()),
    clear: () => clearTimeout(timer),
  };
}

/**
 * Resolve with the work's result if it settles before the deadline; if the
 * deadline fires first, resolve with `fallback()` instead. A work REJECTION
 * before the deadline propagates (so the route's try/catch still handles genuine
 * errors); a rejection after the deadline is swallowed harmlessly (already
 * settled). First settler wins.
 */
export function withDeadline<T>(
  work: Promise<T>,
  deadline: Pick<VoiceDeadline, "signal">,
  fallback: () => T
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    work.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e))
    );
    const onAbort = () => finish(() => resolve(fallback()));
    if (deadline.signal.aborted) onAbort();
    else deadline.signal.addEventListener("abort", onAbort, { once: true });
  });
}
