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
