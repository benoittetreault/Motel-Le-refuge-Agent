import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReservitParams } from "./reservit-link";

const VALID_LINK =
  "http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=10&fmonth=9&fyear=2026&nbnights=3&nbadt=2";

test("valid link: params are pulled and normalized", () => {
  const parsed = parseReservitParams(VALID_LINK);
  assert.deepEqual(parsed, { arrivalDate: "2026-09-10", nights: 3, adults: 2 });
});

test("malformed link (no query string) returns null", () => {
  const parsed = parseReservitParams(
    "http://softbooker.reservit.com/reservit/reserhotel.php"
  );
  assert.equal(parsed, null);
});

test("link missing a param returns null", () => {
  // Same as VALID_LINK but with nbadt (adults) removed.
  const parsed = parseReservitParams(
    "http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=10&fmonth=9&fyear=2026&nbnights=3"
  );
  assert.equal(parsed, null);
});
