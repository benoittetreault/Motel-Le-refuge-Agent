/**
 * Real-time availability checking against the Reservit "Best Price" API.
 *
 * Phase A: single room type, checked one night at a time. We query each night
 * of the requested stay independently (in parallel) and aggregate the results,
 * so we can tell a guest exactly which nights are open when a stay is only
 * partially available.
 */

import { getMotelConfig } from "@workspace/motel-config";

const motel = getMotelConfig();

// e.g. https://secure.reservit.com/api/rs/bestprice/58/444801 (chain / hotel).
const RESERVIT_BEST_PRICE_URL = `${motel.booking.bestPriceBase}/${motel.booking.chainId}/${motel.booking.hotelId}`;

// Per-night request timeout. Each night is an independent HTTP call.
const NIGHT_TIMEOUT_MS = 4000;

// Hard cap on how long a single check may be. Beyond this we bail out rather
// than firing dozens of upstream requests.
const MAX_NIGHTS = motel.booking.maxNights;

export interface NightResult {
  /** Arrival date for this single night, YYYY-MM-DD. */
  date: string;
  available: boolean;
  /** Nightly price when available, otherwise null. */
  price: number | null;
}

export type AvailabilityResult =
  | { status: "all_available"; firstPrice: number | null }
  | { status: "partial"; availableNights: NightResult[]; bookedNights: NightResult[] }
  | { status: "none_available" }
  | { status: "too_long"; requestedNights: number }
  | { status: "check_failed" };

/**
 * Add `days` to a YYYY-MM-DD date string using UTC math, returning YYYY-MM-DD.
 * UTC-based so month/year rollovers (e.g. Jan 30 + 3 nights) never drift due to
 * local-timezone DST shifts.
 */
function addUtcDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Check a single night. Throws on network error, non-2xx response, or timeout —
 * callers must treat any throw as "unknown", never as "booked".
 */
async function checkNight(fromdate: string, adults: number): Promise<NightResult> {
  const todate = addUtcDays(fromdate, 1);

  const params = new URLSearchParams({
    fromdate,
    todate,
    // One "30" (a 30-year-old adult) per guest, e.g. 2 adults -> "30,30".
    roomAge1: Array.from({ length: adults }, () => "30").join(","),
    lang: "EN",
    currency: motel.booking.currency,
    serviceIncluded: "false",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NIGHT_TIMEOUT_MS);

  try {
    const res = await fetch(`${RESERVIT_BEST_PRICE_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Reservit best-price responded ${res.status} for ${fromdate}`);
    }

    const data = (await res.json()) as { bestPrice_unFormatted?: unknown };
    const raw = data?.bestPrice_unFormatted;

    // A positive number means bookable; -1 or a missing field means booked.
    const available = typeof raw === "number" && raw > 0;

    return { date: fromdate, available, price: available ? (raw as number) : null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check availability for a stay of `nights` nights starting on `fromDate`
 * (YYYY-MM-DD) for `adults` guests.
 *
 * Fails closed: if ANY night's request throws or times out, the entire result
 * is `check_failed` — we never report a partial/guessed answer on error.
 */
export async function checkAvailability(
  fromDate: string,
  nights: number,
  adults: number
): Promise<AvailabilityResult> {
  if (nights > MAX_NIGHTS) {
    return { status: "too_long", requestedNights: nights };
  }

  const adultCount = Math.max(1, adults);

  let results: NightResult[];
  try {
    results = await Promise.all(
      Array.from({ length: nights }, (_, i) =>
        checkNight(addUtcDays(fromDate, i), adultCount)
      )
    );
  } catch {
    // Any single-night failure poisons the whole check.
    return { status: "check_failed" };
  }

  const availableNights = results.filter((n) => n.available);
  const bookedNights = results.filter((n) => !n.available);

  if (bookedNights.length === 0) {
    return { status: "all_available", firstPrice: results[0]?.price ?? null };
  }
  if (availableNights.length === 0) {
    return { status: "none_available" };
  }
  return { status: "partial", availableNights, bookedNights };
}
