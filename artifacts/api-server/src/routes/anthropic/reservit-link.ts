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
