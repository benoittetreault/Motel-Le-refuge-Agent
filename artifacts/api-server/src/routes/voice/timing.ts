// Request-scoped duration instrumentation for the voice route.
//
// Collects labelled millisecond durations for one voice request and produces a
// compact, SECRET-FREE summary the route logs once at the end. Values are
// durations and counts only — never a phone number, URL, message body, token,
// or transcript. Pure and dependency-free so it is trivially unit-testable and
// safe to thread through the model/availability code.

/** A sink the instrumented code calls to record one duration. */
export type TimingSink = (label: string, ms: number) => void;

export interface TimingSummaryEntry {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface Timings {
  /** Record a single (label, ms) measurement. Safe to pass as a TimingSink. */
  add: TimingSink;
  /** Time an async span under `label` and record its duration. */
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Aggregate all measurements by label — count / total / max, all numbers. */
  summary(): Record<string, TimingSummaryEntry>;
}

export function createTimings(now: () => number = Date.now): Timings {
  const marks: Array<{ label: string; ms: number }> = [];

  const add: TimingSink = (label, ms) => {
    marks.push({ label, ms });
  };

  return {
    add,
    async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const start = now();
      try {
        return await fn();
      } finally {
        add(label, now() - start);
      }
    },
    summary(): Record<string, TimingSummaryEntry> {
      const out: Record<string, TimingSummaryEntry> = {};
      for (const m of marks) {
        const e = (out[m.label] ??= { count: 0, totalMs: 0, maxMs: 0 });
        e.count += 1;
        e.totalMs += m.ms;
        if (m.ms > e.maxMs) e.maxMs = m.ms;
      }
      return out;
    },
  };
}
