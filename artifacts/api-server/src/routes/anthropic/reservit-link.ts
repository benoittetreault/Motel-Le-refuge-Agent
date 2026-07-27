// Engine-level Reservit booking-link pattern — pure, no dependencies, so any
// channel can import it without pulling in the model client. Mirrors
// config.booking.linkBase; shared by every motel on Reservit, so it is not part
// of the per-motel config. The web route uses it to verify links; the voice
// route uses it to strip them (a link can't be spoken).
export const RESERVIT_LINK_RE = /softbooker\.reservit\.com\/reservit\/reserhotel\.php\?[^\s)]+/i;
export const RESERVIT_LINK_RE_G = new RegExp(RESERVIT_LINK_RE.source, "gi");

// Return every Reservit booking link in the text (one per room a multi-type
// group booking would offer). Empty array if none.
export function findAllReservitLinks(text: string): string[] {
  return text.match(RESERVIT_LINK_RE_G) ?? [];
}

// Pull fday/fmonth/fyear/nbnights/nbadt out of a Reservit link and normalize them
// into checkAvailability's arguments. Returns null if anything is missing/invalid.
export function parseReservitParams(
  link: string
): { arrivalDate: string; nights: number; adults: number } | null {
  const q = link.indexOf("?");
  if (q === -1) return null;
  const params = new URLSearchParams(link.slice(q + 1));
  const day = Number.parseInt(params.get("fday") ?? "", 10);
  const month = Number.parseInt(params.get("fmonth") ?? "", 10);
  const year = Number.parseInt(params.get("fyear") ?? "", 10);
  const nights = Number.parseInt(params.get("nbnights") ?? "", 10);
  const adults = Number.parseInt(params.get("nbadt") ?? "", 10);
  if ([day, month, year, nights, adults].some((n) => !Number.isFinite(n) || n <= 0)) {
    return null;
  }
  const arrivalDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { arrivalDate, nights, adults };
}

// ---- Strict validation + server-side link construction ----------------------
// A model-generated booking link is UNTRUSTED input. Before we ever text one to
// a guest we (a) validate it points at OUR hotel on the exact Reservit host/path
// with sane parameters, then (b) throw the model's URL away and rebuild the link
// server-side from trusted motel config. This means a model-supplied hotelid,
// an extra query parameter, or a look-alike host can never redirect the guest.

const RESERVIT_HOST = "softbooker.reservit.com";
const RESERVIT_PATH = "/reservit/reserhotel.php";

export interface ReservitBooking {
  /** Arrival date, YYYY-MM-DD (for the availability re-check). */
  arrivalDate: string;
  day: number;
  month: number;
  year: number;
  nights: number;
  adults: number;
  /** "EN" | "FR" — echoed back into the rebuilt link; defaults to EN. */
  lang: "EN" | "FR";
}

// Parse a string of digits ONLY (rejects "10abc", "", "-1", "1.5"). Returns null
// when the whole value is not a run of digits.
function strictDigits(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function inRange(n: number | null, min: number, max: number): n is number {
  return n !== null && n >= min && n <= max;
}

// Reject impossible calendar dates (e.g. Feb 31) by round-tripping through UTC.
function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

/**
 * Validate a model-emitted Reservit link against the motel's own hotel id and
 * strict parameter rules. Returns the validated booking, or null on ANY problem:
 * unparseable, wrong host, wrong path, wrong/missing hotelid, missing/invalid or
 * out-of-range fday/fmonth/fyear/nbnights/nbadt, or an impossible date.
 *
 * The link captured by findAllReservitLinks has its protocol stripped by the
 * pattern, so we normalize a scheme on just to parse it; the scheme is never
 * trusted or reused (buildReservitLink supplies the canonical base).
 */
export function parseAndValidateReservitLink(
  link: string,
  expectedHotelId: string
): ReservitBooking | null {
  let u: URL;
  try {
    const withScheme = /^https?:\/\//i.test(link) ? link : `http://${link}`;
    u = new URL(withScheme);
  } catch {
    return null;
  }

  if (u.hostname.toLowerCase() !== RESERVIT_HOST) return null;
  if (u.pathname !== RESERVIT_PATH) return null;

  const p = u.searchParams;
  // Never trust the model's hotelid — it must exactly match server config.
  if (p.get("hotelid") !== expectedHotelId) return null;

  const day = strictDigits(p.get("fday"));
  const month = strictDigits(p.get("fmonth"));
  const year = strictDigits(p.get("fyear"));
  const nights = strictDigits(p.get("nbnights"));
  const adults = strictDigits(p.get("nbadt"));

  if (
    !inRange(day, 1, 31) ||
    !inRange(month, 1, 12) ||
    !inRange(year, 2020, 2100) ||
    !inRange(nights, 1, 30) ||
    !inRange(adults, 1, 16)
  ) {
    return null;
  }
  if (!isRealDate(year, month, day)) return null;

  const langRaw = (p.get("lang") ?? "").toUpperCase();
  const lang: "EN" | "FR" = langRaw === "FR" ? "FR" : "EN";

  const arrivalDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { arrivalDate, day, month, year, nights, adults, lang };
}

/**
 * Build the canonical guest-facing booking URL from TRUSTED config plus the
 * validated booking. The hotel id always comes from config, never the model.
 */
export function buildReservitLink(
  linkBase: string,
  hotelId: string,
  b: ReservitBooking
): string {
  return (
    `${linkBase}?lang=${b.lang}&hotelid=${hotelId}` +
    `&fday=${b.day}&fmonth=${String(b.month).padStart(2, "0")}&fyear=${b.year}` +
    `&nbnights=${b.nights}&nbadt=${b.adults}`
  );
}
