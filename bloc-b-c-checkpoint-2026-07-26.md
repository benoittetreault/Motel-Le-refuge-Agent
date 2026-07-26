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

## Files changed / why

| File | Change |
|------|--------|
| `routes/voice/booking-sms.ts` (new) | Orchestrator: dedup → verify → resolve number → send → decide spoken reply. Deps injected (testable without server/Reservit/Twilio). |
| `routes/voice/sent-link-store.ts` (new) | Per-call, TTL-bounded in-memory dedup store. Length-prefixed composite key (no `(callId,key)` collisions). Factory + singleton. |
| `routes/voice/concierge.ts` (mod) | Added `inviteToCallReply`, `smsSentReply` (bilingual, URL-free), `resolveGuestPhone` (metadata→DTMF). Refactored `toSpokenReply` to reuse `inviteToCallReply` (behavior identical). |
| `routes/voice/index.ts` (mod) | Wired the link-bearing branch to `orchestrateBookingSms`; no-link branch unchanged. Secret-free outcome log. Header comment updated. |
| `routes/voice/booking-sms.test.ts` (new) | 12 orchestrator cases (success, fail, no/invalid number, not-available, check_failed, dedup, retry-after-fail, multi-link, unparseable, no-callId, URL-never-spoken). |
| `routes/voice/sent-link-store.test.ts` (new) | 5 dedup cases (mark/scope/TTL-expiry/refresh/no-forgery). |
| `routes/voice/voice.test.ts` (mod) | +6 cases: `resolveGuestPhone` priority/fallback/null, `inviteToCallReply`/`smsSentReply` never leak URL/over-promise. |
| `ARCHITECTURE.md` (mod) | §8 rewritten: Bloc B/C implemented, concierge-net approach, Twilio env vars. |

## Architecture decisions

- **Concierge-net, not prompt rework.** Keeps the golden prompt frozen and makes the SMS
  confirmation deterministic (strongest guarantee against a false "sent"). User-approved.
- **Dedup in-memory, per call.** Calls are short-lived and single-instance; no external store.
- **Verification mirrors the web route** (`check_failed`/unparseable non-blocking) for
  cross-channel consistency.
- **Dependency injection** in the orchestrator for full unit-test coverage without live providers.

## Tests executed & results (run from the worktree)

- `pnpm --filter @workspace/api-server test` → **69 pass / 0 fail** (was 47 baseline pre-Bloc-B/C).
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
- Dedup does not survive a process restart mid-call (acceptable: worst case one duplicate SMS).
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
