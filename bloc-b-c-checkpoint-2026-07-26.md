# Checkpoint — Voice Bloc B / Bloc C (booking-link SMS)

- **Date**: 2026-07-26
- **Branch**: `claude/front-desk-bloc-b-c-967cf0`
- **Git status at write time**: 3 files modified, 4 new files, `dist/` gitignored. **Not committed** (awaiting review).
- **Deployment status**: **NOT deployed, NOT merged.** Bloc B and Bloc C ship together only.
  **No live-provider testing has been performed** — all verification so far is offline (unit
  tests with injected fakes, typecheck, prod bundle). Deployment is **gated on** manual live
  verification against real **Vapi**, **Twilio**, and **Reservit** (see checklist at the end).

## Completed work

Bloc B (voice may promise an SMS booking link) + Bloc C (actually send it via Twilio),
implemented **entirely in the post-generation "concierge net" layer**. The shared system
prompt and its golden snapshot are **unchanged** (no prompt-diff PR / golden update needed).

Behavior when the model's candidate reply contains a Reservit booking link, per voice turn:
1. **Dedup guard first** — per-call, per-link-set in-memory store (TTL 2 h). Vapi replays the
   whole history each turn, so a re-emitted link on a later turn re-speaks the confirmation
   **without** sending a second SMS.
2. **Server-side availability re-verification** — `parseReservitParams` → `checkAvailability`
   for each link. `check_failed` (Reservit unreachable) and unparseable links do **not** block
   (mirrors the web route); a definitive `none_available` / `partial` / `too_long` blocks the
   send and falls back to invite-to-call.
3. **Guest number resolution** — verified `call.customer.number` (E.164) first, else DTMF
   keypad entry via `extractKeypadPhone`. We never intentionally parse a spoken number; the
   fallback is the Vapi keypad. (Caveat below.) No number → invite-to-call.
4. **SMS send** — `sendBookingLinkSms` (Twilio, never throws). On success → mark sent + speak
   "sent by text" (no URL, no phone number spoken). On any failure → invite-to-call.

The spoken confirmation is **code-generated and deterministic**, so the assistant can never
say "I've texted you the link" unless an SMS was actually sent successfully. Web chat is
untouched — all SMS logic lives in the voice route.

**Log redaction (security follow-up).** Normal (always-on) logs never contain a complete guest
number, the SMS body/booking URL, or Twilio credentials/auth. A reusable `maskPhone` helper
(`lib/redact.ts`) renders `+15195551234` → `+1******1234`; it masks the per-turn "voice:
incoming turn" log and `sms.ts`'s invalid-input path. On Twilio errors `sms.ts` logs only
`status` + numeric `twilioCode` (not the raw body, which echoes the number); on a 2xx without a
sid it logs field *names* only; on network/timeout it logs the error *name* only (never the raw
error, whose URL carries the account SID). `VOICE_DEBUG_LOG` (opt-in, off by default) still
exposes full numbers by design and must stay disabled in production — the always-on logs are
already safe in code, not only by documentation.

## Files changed / why

| File | Change |
|------|--------|
| `routes/anthropic/reservit-link.ts` (mod) | Added `parseAndValidateReservitLink` (strict host/path/hotelid/param/date validation) + `buildReservitLink` (server-side canonical URL from config). `parseReservitParams` unchanged (web route). |
| `routes/anthropic/reservit-link.test.ts` (mod) | +8 validation cases (valid, scheme-optional, wrong host/path/hotel, missing/non-numeric/out-of-range/impossible-date, extra params ignored, canonical build). |
| `routes/voice/booking-sms.ts` (new) | Orchestrator: require callId → validate+rebuild links server-side → atomic claim → verify → resolve number → send → release/markSent. Deps injected. |
| `routes/voice/sent-link-store.ts` (new) | Concurrency-safe atomic claim store (not-claimed → in-flight → sent), `claim`/`markSent`/`release`, TTL, length-prefixed key. Single-process. |
| `routes/voice/concierge.ts` (mod) | Added `inviteToCallReply`, `smsSentReply` (URL-free), `resolveGuestPhone` (metadata→DTMF, strict E.164), `voiceDebugEnabled` (prod-gated). `toSpokenReply` refactored, behavior identical. |
| `routes/voice/index.ts` (mod) | Wired orchestrator (passes `bookingConfig`); masked caller/dialed numbers in the per-turn log; both `VOICE_DEBUG_LOG` blocks gated by `voiceDebugEnabled`. |
| `routes/voice/booking-sms.test.ts` (new) | 20 cases incl. server-side validation (unparseable/wrong host/path/hotel/missing param/extra-params-ignored), concurrency (`Promise.all` → one send), missing-callId, dedup/retry, URL-never-spoken. |
| `routes/voice/sent-link-store.test.ts` (mod) | 8 cases: claim/in-flight/already-sent, release retryable, release-never-unsends, scope, TTL (in-flight + sent), refresh, no-forgery. |
| `routes/voice/voice.test.ts` (mod) | +`resolveGuestPhone` and spoken-helper cases; +`voiceDebugEnabled` prod-gating cases. |
| `lib/redact.ts` (new) | Reusable `maskPhone` helper (`+1******1234`), defensive on non-string/short input. |
| `lib/redact.test.ts` (new) | 5 cases: E.164 masking, head/tail-only, short-value full mask, non-string/empty safety, never-throws. |
| `lib/sms.ts` (mod) | Strict E.164 boundary. Redacted all error logs: masked number on invalid-input; status+`twilioCode` (not body) on non-2xx; field-names-only on 2xx-no-sid; error-name-only on timeout/network. Send behavior unchanged. |
| `lib/sms.test.ts` (mod) | +log-redaction cases and +strict-E.164 accept/reject cases. |
| `ARCHITECTURE.md` (mod) | §8 rewritten (hardened flow, single-process idempotency, Railway note); §6.5 (log redaction + debug-flag warning). |

## PR #27 hardening (pre-merge blocking review)

- **Concurrency-safe dedup.** `sent-link-store` is now an atomic state machine per `(callId, key)`: not-claimed → in-flight → sent, with `claim`/`markSent`/`release`. `claim` runs synchronously before any `await`, so two simultaneous turns cannot both send (one gets `claimed`, the other `in_flight`); a failed send `release`s for retry. Proven by a `Promise.all` test asserting `sendSms` fires exactly once. **Single process only** — no cross-instance idempotency (see limitations).
- **Server-side link construction.** Model links are untrusted: `parseAndValidateReservitLink` enforces exact host, exact path, config `hotelid`, and valid/in-range/real-date params; the URL is then rebuilt from config via `buildReservitLink`. A wrong host/path/hotel or an injected query param can never reach the guest or redirect. Any invalid link → no SMS, invite-to-call.
- **Idempotency requires a call id.** A link-bearing turn with no `callId` → no SMS, invite-to-call, log reason `missing_call_id`.
- **Strict E.164** at the provider boundary (`/^\+[1-9]\d{7,14}$/`) and in the resolver.
- **Collision-proof dedup key** via `JSON.stringify` of the sorted canonical URLs (no delimiter forgery).
- **`VOICE_DEBUG_LOG` blocked in production** via `voiceDebugEnabled` (flag must be `"true"` AND `NODE_ENV !== "production"`), so an accidentally-on flag cannot leak PII in prod.
- **`check_failed` is never called "verified."** Reservit-unreachable is non-blocking but explicitly not a verification claim.

## Live latency fix (PR #27, found on pr-27-test)

A browser webCall (`callId 019f9f4b…`) took ~22.2s server-side; Vapi abandoned the turn at its ~20s provider timeout (`providerfault-model-no-response`). Twilio was not involved (`no_number`). Two causes and a safety net:

- **Duplicate availability check removed.** The model tool-loop checked availability, then `orchestrateBookingSms` re-checked the same dates before texting — two identical Reservit round-trips. Added `createRequestAvailability` (availability.ts): a **request-scoped, promise-memoized** wrapper keyed exactly by `arrivalDate+nights+adults`, shared by `generateReply`'s tool loop and the orchestrator. Same dates → one network check. Validation is **unchanged** (host/path/hotelid/date still enforced, URL still rebuilt server-side); a cache hit only reuses a result for exactly the params validated from the server-built link. Fresh per request — never a stale cross-request cache.
- **Hard voice deadline.** `createVoiceDeadline` (15s) + `withDeadline` wrap the whole pipeline. If it can't finish, we speak a safe **invite-to-call** fallback (never claims availability or an SMS) well before Vapi's 20s. Target <12s, hard ceiling 15s.
- **No late / no false SMS.** The orchestrator takes a `deadline`; before starting a send it refuses if expired or if < ~4.5s budget remains (releases the claim, invites to call). The Twilio fetch also receives `deadline.signal`, so any in-flight send aborts at the deadline. A timeout can never produce a "sent" claim, and no SMS fires after the guest has heard the fallback.
- **Instrumentation.** Secret-free per-request duration log `voice: request timing` — `{ totalMs, timedOut, timings }` where `timings` aggregates `model_round`, `check_availability`, `availability_cache_hit`, `reservit_night`, `generate_reply`, `orchestrate_sms`, `sse_write` (counts/durations only, no PII).

New/changed for this fix: `timing.ts`(+test), `deadline.ts`(+test), `availability.ts`(+`availability.test.ts`), `chat-brain.ts` (inject availability + timing), `booking-sms.ts` (deadline gate), `sms.ts` (optional abort signal), `voice/index.ts` (wire it all).

## Architecture decisions

- **Concierge-net, not prompt rework.** Keeps the golden prompt frozen and makes the SMS
  confirmation deterministic (strongest guarantee against a false "sent"). User-approved.
- **Dedup in-memory, per call.** Calls are short-lived and single-instance; no external store.
- **Verification mirrors the web route** (`check_failed`/unparseable non-blocking) for
  cross-channel consistency.
- **Dependency injection** in the orchestrator for full unit-test coverage without live providers.

## Tests executed & results (run from the worktree)

- `pnpm --filter @workspace/api-server test` → **117 pass / 0 fail** (Bloc B/C + log-redaction + hardening + latency fix).
- `pnpm --filter @workspace/api-server typecheck` (after `npx tsc -b tsconfig.json`) → **exit 0**.
- `node artifacts/api-server/build.mjs` (prod esbuild server bundle) → **exit 0**.
- No lint step is configured in this repo.

> Environment note: the repo runs in a **git worktree** (`.claude/worktrees/goofy-pike-ddad05`).
> Run commands from the worktree path, not the main checkout, or you will test stale files.
> Typecheck needs `npx tsc -b tsconfig.json` first (builds composite project references;
> otherwise `TS6305` from a missing `lib/motel-config/dist`).

## Known limitations / assumptions

- **DTMF heuristic**: `extractKeypadPhone` (pre-existing, merged) accepts any user message
  reducing to exactly 10 / 11-leading-1 digits. It cannot distinguish a keypad injection from a
  spoken number transcribed to the same clean digits, so a dictated number is not guaranteed to
  be rejected. Metadata is preferred; this only affects the keypad fallback. Not changed here
  (separate merged feature); tighten separately if the live keypad format allows a hard marker.
- SMS body language is fixed bilingual FR/EN (not per-guest-language).
- **Dedup is single-process, in-memory.** It prevents duplicate/concurrent sends within one Node
  instance only — it gives NO cross-instance idempotency. `railway.json` declares no replicas and
  Railway defaults to 1 instance, so this is sufficient today, but that is the repo default and has
  **not been verified against the live Railway dashboard**. Running >1 replica would allow one SMS
  per instance; cross-instance safety would need a shared store (Redis) or a DB uniqueness
  constraint. Dedup also does not survive a process restart mid-call (worst case: one duplicate SMS).
- Availability is re-checked every non-duplicate link turn (extra Reservit latency), consistent
  with the web route.
- Requires `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` in prod; absent →
  `not_configured` → invite-to-call fallback (safe, never a false claim).
- Unrelated pre-existing items (out of scope): `booking.currency: "USD"` likely should be CAD;
  dead root `index.js`.

## Next recommended task

1. Manual production verification (see below) with a real Vapi call once Twilio env is set.
2. Optional Bloc B polish (dedicated voice prompt: short TTS sentences, First Message) — this
   **would** change the golden snapshot and needs a prompt-diff PR reviewed by Benoit.

## Manual production-verification checklist

- [ ] Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (Canadian/Twilio-verified sender).
- [ ] Real Vapi call, ask to book a valid available date → hear the "sent by text" confirmation, receive one SMS with the correct Reservit link.
- [ ] Confirm the booking link is **never spoken** aloud in any turn.
- [ ] Continue the call so the model re-emits the link on a later turn → confirm **no second SMS** and the confirmation is re-spoken.
- [ ] Book dates that are **not** available → hear invite-to-call, receive **no** SMS.
- [ ] Call from a blocked/withheld number without keying a number → invite-to-call, no SMS.
- [ ] Key a callback number on the dial pad → SMS goes to the keyed number.
- [ ] Temporarily misconfigure Twilio (or watch a transient failure) → assistant invites to call, never claims a send.
- [ ] Verify logs show the secret-free `booking-link SMS outcome` (status/reason only, no number/URL/token).
- [ ] Confirm web chat is unaffected (normal booking link still returned in-page).
