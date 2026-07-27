// Small, dependency-free redaction helpers for logs.
//
// Guest phone numbers, SMS bodies, booking URLs, and provider tokens must never
// land in normal application logs. These helpers give us a single, consistent
// masked representation so no call site has to hand-roll (and get wrong) its own
// redaction.

/**
 * Mask a phone number for logging, keeping just enough to correlate entries
 * without ever writing the complete number.
 *
 * Shape: the first two characters (e.g. the "+1" country prefix) and the last
 * four digits are kept; everything between is replaced with "*". So a valid
 * E.164 number like "+15195551234" becomes "+1******1234".
 *
 * Defensive by construction:
 *  - non-string / empty input → "<no-number>" (never throws, never echoes a
 *    non-string value's contents),
 *  - a value too short to partially reveal safely (<= 6 chars) is fully masked,
 *    so a malformed or unexpectedly short value can never be leaked in the clear.
 */
export function maskPhone(value: unknown): string {
  if (typeof value !== "string") return "<no-number>";
  const s = value.trim();
  if (s === "") return "<no-number>";
  // 6 = the 2 head + 4 tail characters we reveal. At or below that length there
  // is nothing safe to hide behind, so mask the whole thing rather than expose
  // most of a short value.
  if (s.length <= 6) return "*".repeat(s.length);
  const head = s.slice(0, 2);
  const tail = s.slice(-4);
  const middle = "*".repeat(s.length - 6);
  return `${head}${middle}${tail}`;
}
