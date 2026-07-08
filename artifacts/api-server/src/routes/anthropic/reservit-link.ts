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
