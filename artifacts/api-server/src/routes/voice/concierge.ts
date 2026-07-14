import { createHash, timingSafeEqual } from "node:crypto";
import { findAllReservitLinks, RESERVIT_LINK_RE_G } from "../anthropic/reservit-link";
import { stripToolTags } from "../anthropic/strip-tool-tags";
// Type-only import: erased at compile time, so this module never pulls in the
// model client (chat-brain imports the Anthropic SDK, which throws without an
// API key). That keeps these helpers unit-testable in isolation.
import type { ChatMessageList } from "../anthropic/chat-brain";

// Pure helpers for the Vapi voice route. Kept separate from index.ts so the
// route's testable logic (auth, history mapping, the concierge link net) can be
// exercised without a running server or an Anthropic API key.

// Header name carrying Vapi's shared secret. Configurable because the exact name
// is set when the Custom LLM credential is created in Vapi and is confirmed from
// the debug log on the first real call.
export const DEFAULT_VAPI_SECRET_HEADER = "x-vapi-secret";

export interface VapiMessage {
  role?: string;
  content?: unknown;
}

// Constant-time comparison over SHA-256 digests (fixed length, so no length leak
// and no throw from timingSafeEqual on differing input lengths).
export function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Read the shared secret from the configured custom header, falling back to
// "Authorization: Bearer <secret>". Returns null when neither is present.
export function extractProvidedSecret(
  headers: Record<string, unknown>,
  secretHeader: string = DEFAULT_VAPI_SECRET_HEADER
): string | null {
  const custom = headers[secretHeader.toLowerCase()];
  if (typeof custom === "string" && custom.length > 0) return custom;
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

// Map Vapi's OpenAI-format history to our brain's message list. Vapi sends the
// FULL conversation every turn, so the voice channel persists nothing (unlike
// web chat, which stores turns in the DB). We keep only user/assistant text and
// drop Vapi's own system message (our buildSystemPrompt wins inside the brain)
// and any tool-role messages.
export function mapVapiMessages(messages: VapiMessage[]): ChatMessageList {
  const mapped: ChatMessageList = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.content !== "string" || m.content.trim() === "") continue;
    mapped.push({ role: m.role, content: m.content });
  }
  return mapped;
}

// ---- VOICE_DEBUG_LOG: curated, secret-free debug payload --------------------
// The raw Vapi payload + request headers are a minefield of secrets and PII: the
// x-vapi-secret and Authorization headers, SIP SHAKEN/STIR identity tokens (both
// as structured headers AND embedded inside call.phoneCallProviderDetails.sip.raw),
// a duplicate x-vapi-secret echoed in assistant.model.headers, plus carrier/account
// SIDs and variableValues. Rather than redact that sprawl field-by-field, we build
// an explicit allowlist of ONLY what debugging actually needs: the mapped messages
// (so we can see "User's Keypad Entry: ..."), the caller/dialed numbers, and the
// callId. Nothing else is ever read, so no secret can leak by construction.

/** The narrow slice of the Vapi payload the debug helper is allowed to read. */
export interface VoiceDebugPayload {
  call?: {
    id?: string;
    phoneNumber?: { number?: string };
    customer?: { number?: string };
  };
}

export interface VoiceDebugInfo {
  callId: string | undefined;
  /** phoneNumber.number — the number the guest DIALED. */
  dialedNumber: string | undefined;
  /** customer.number — the caller's own number (guest PII, kept for debugging). */
  callerNumber: string | undefined;
  messageCount: number;
  messages: ChatMessageList;
}

// Build the curated debug object from a NEWLY-constructed literal — never a view
// onto req.body — so processing keeps using the untouched real payload. Only the
// five fields below are copied out; headers, the SIP blob, the assistant-config
// echo, variableValues and carrier SIDs are never referenced and cannot appear.
export function buildVoiceDebugInfo(
  payload: VoiceDebugPayload,
  mapped: ChatMessageList,
  callId?: string
): VoiceDebugInfo {
  return {
    callId: callId ?? payload.call?.id,
    dialedNumber: payload.call?.phoneNumber?.number,
    callerNumber: payload.call?.customer?.number,
    messageCount: mapped.length,
    messages: mapped,
  };
}

// ---- Keypad phone extraction (DTMF → E.164) ---------------------------------
// On the voice channel the guest keys a callback number on the phone dial pad and
// Vapi injects it as a user message whose content looks like
// "User's Keypad Entry: 5551234567". We deliberately do NOT hard-match that exact
// wrapper text (Vapi could reword it); instead we strip every non-digit character
// from the content and judge the resulting digit string purely on length. The
// same entry can land in history MORE THAN ONCE — a DTMF inter-digit timeout and
// the "#" terminator both inject it — so scanning backward and returning the
// first valid hit naturally dedupes without special-casing.
//
// Only role "user" messages are considered: an assistant turn that happens to
// contain digits (a price, a date) is never the guest's number. The length guard
// is strict so ordinary numeric chatter ("September 10", "we are 2 people", a
// truncated 7-digit entry) can never be misread as a phone number:
//   - exactly 10 digits             → North American number, prepend "+1"
//   - exactly 11 digits, leading "1" → already country-coded, prepend "+"
//   - anything else                  → not a phone number, keep scanning backward
// Returns the most recent valid number in E.164, or null if history has none.
export function extractKeypadPhone(messages: ChatMessageList): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content !== "string") continue;
    const digits = m.content.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }
  return null;
}

// The concierge net: turn the brain's candidate reply into something safe to
// speak. If a booking link is present it is replaced wholesale with a bilingual
// invitation to call (TODO Bloc B: a voice-specific prompt should avoid links at
// the source). Any stray link and tool-syntax leakage is stripped regardless.
export function toSpokenReply(
  candidate: string,
  opts: { phone: string; hours: string }
): string {
  let reply = candidate;
  if (findAllReservitLinks(reply).length > 0) {
    reply =
      `Pour finaliser votre réservation, appelez-nous directement au ${opts.phone}, ` +
      `pendant nos heures d'ouverture (${opts.hours}), et notre équipe s'occupera de tout. / ` +
      `To finalize your booking, please call us directly at ${opts.phone} during our hours (${opts.hours}) and our team will take care of everything.`;
  }
  reply = reply.replace(RESERVIT_LINK_RE_G, "").replace(/[ \t]{2,}/g, " ").trim();
  return stripToolTags(reply).text;
}

// ---- SSE response formatting (Vapi Custom LLM) --------------------------------
// Vapi's Custom LLM endpoint only speaks a reply that arrives as an OpenAI
// streaming response (Server-Sent Events of chat.completion.chunk) — a plain
// non-streaming JSON body leaves the assistant silent, even though Vapi always
// sends stream:true. We do NOT stream the model: generateReply + toSpokenReply
// still produce the complete, concierge-verified text first, and only THEN do we
// wrap that finished text as SSE. Nothing can leak mid-generation because we
// don't emit a byte until the safe reply is fully in hand.
//
// These helpers are pure (no HTTP) so the exact chunk shape is unit-tested; the
// route just sets headers and writes the payload string.

export interface SseChunkMeta {
  /** Same id echoed on every chunk of one response. */
  id: string;
  /** Model label echoed back (from the request, or a default). */
  model: string;
  /** Unix seconds; identical on every chunk of one response. */
  created: number;
}

// The chunk sequence mirrors a real OpenAI stream so Vapi's accumulator handles
// it exactly like a native provider: role announced first, then the full text
// in one content delta, then an empty delta carrying finish_reason:"stop". We
// emit the whole reply in a single content chunk (no word-by-word split) since
// the text is already complete.
export function buildSseChunks(reply: string, meta: SseChunkMeta): Array<Record<string, unknown>> {
  const base = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
  };
  return [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

// Serialize the chunks as an SSE payload: one `data: <json>\n\n` line per chunk,
// terminated by the literal `data: [DONE]\n\n` sentinel Vapi expects.
export function formatSsePayload(reply: string, meta: SseChunkMeta): string {
  const lines = buildSseChunks(reply, meta).map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}
