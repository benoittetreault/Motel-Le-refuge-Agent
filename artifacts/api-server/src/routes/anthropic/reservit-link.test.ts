import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReservitParams,
  parseAndValidateReservitLink,
  buildReservitLink,
} from "./reservit-link";

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

// ---- parseAndValidateReservitLink (strict, hotel-scoped) --------------------

const HOTEL = "444801";
// Protocol-stripped form (as findAllReservitLinks yields).
const VALID_STRIPPED =
  "softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2";

test("valid link for our hotel validates and normalizes", () => {
  const b = parseAndValidateReservitLink(VALID_STRIPPED, HOTEL);
  assert.deepEqual(b, {
    arrivalDate: "2026-09-15",
    day: 15,
    month: 9,
    year: 2026,
    nights: 2,
    adults: 2,
    lang: "EN",
  });
});

test("validates links with or without an explicit scheme", () => {
  assert.ok(parseAndValidateReservitLink("http://" + VALID_STRIPPED, HOTEL));
  assert.ok(parseAndValidateReservitLink("https://" + VALID_STRIPPED, HOTEL));
});

test("rejects a wrong hostname (look-alike suffix)", () => {
  const evil = VALID_STRIPPED.replace("softbooker.reservit.com", "softbooker.reservit.com.evil.example");
  assert.equal(parseAndValidateReservitLink(evil, HOTEL), null);
});

test("rejects a wrong path", () => {
  const wrong = VALID_STRIPPED.replace("/reservit/reserhotel.php", "/evil/reserhotel.php");
  assert.equal(parseAndValidateReservitLink(wrong, HOTEL), null);
});

test("rejects another hotel's id (never trust model hotelid)", () => {
  const other = VALID_STRIPPED.replace("hotelid=444801", "hotelid=999999");
  assert.equal(parseAndValidateReservitLink(other, HOTEL), null);
  // Also rejects a missing hotelid.
  const noHotel = VALID_STRIPPED.replace("hotelid=444801&", "");
  assert.equal(parseAndValidateReservitLink(noHotel, HOTEL), null);
});

test("rejects missing / non-numeric / out-of-range / impossible-date params", () => {
  assert.equal(
    parseAndValidateReservitLink(VALID_STRIPPED.replace("&nbadt=2", ""), HOTEL),
    null,
    "missing nbadt"
  );
  assert.equal(
    parseAndValidateReservitLink(VALID_STRIPPED.replace("nbadt=2", "nbadt=abc"), HOTEL),
    null,
    "non-numeric adults"
  );
  assert.equal(
    parseAndValidateReservitLink(VALID_STRIPPED.replace("fmonth=09", "fmonth=13"), HOTEL),
    null,
    "month out of range"
  );
  assert.equal(
    parseAndValidateReservitLink(VALID_STRIPPED.replace("nbnights=2", "nbnights=0"), HOTEL),
    null,
    "zero nights"
  );
  assert.equal(
    parseAndValidateReservitLink(
      VALID_STRIPPED.replace("fday=15", "fday=31").replace("fmonth=09", "fmonth=02"),
      HOTEL
    ),
    null,
    "Feb 31 is not a real date"
  );
});

test("extra/injected query params are ignored (only known fields used)", () => {
  const withExtras = VALID_STRIPPED + "&evilRedirect=1&hotelid2=999999";
  const b = parseAndValidateReservitLink(withExtras, HOTEL);
  assert.ok(b);
  assert.equal(b?.adults, 2);
});

test("buildReservitLink constructs a canonical URL from trusted config only", () => {
  const b = parseAndValidateReservitLink(VALID_STRIPPED + "&evilRedirect=1", HOTEL);
  assert.ok(b);
  const url = buildReservitLink("http://softbooker.reservit.com/reservit/reserhotel.php", HOTEL, b!);
  assert.equal(
    url,
    "http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=15&fmonth=09&fyear=2026&nbnights=2&nbadt=2"
  );
  // The injected param never survives into the built URL.
  assert.doesNotMatch(url, /evilRedirect/);
});
