import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getMotelConfig } from "@workspace/motel-config";
import { checkAvailability } from "./availability";
import { buildToolResults } from "./tool-results";
import { buildSystemPrompt } from "./system-prompt";

// Shared conversation "brain" for every channel (web chat + voice). The model
// call, the check_availability tool loop, and the Reservit link pattern all
// live here so both routes drive the exact same logic. Channel-specific
// behavior (web: server-side link verification; voice: strip links + invite to
// call) stays in each route.

const motel = getMotelConfig();

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;
// Bound the tool conversation so a misbehaving model can't loop forever.
const MAX_TOOL_ROUNDS = 4;

// Reuse the SDK's message-array type without importing the SDK directly.
export type ChatMessageList = Parameters<typeof anthropic.messages.stream>[0]["messages"];

const CHECK_AVAILABILITY_TOOL = {
  name: "check_availability",
  description:
    "Check room availability for specific dates before generating a booking link. Call this whenever the guest has given an exact arrival date, number of nights, and number of adults.",
  input_schema: {
    type: "object" as const,
    properties: {
      arrivalDate: { type: "string", description: "YYYY-MM-DD" },
      nights: { type: "integer" },
      adults: { type: "integer" },
    },
    required: ["arrivalDate", "nights", "adults"],
  },
};

// Matches a Reservit booking link anywhere in the model's reply (scheme optional).
// Engine-level pattern (mirrors config.booking.linkBase) — shared by every motel
// on Reservit, so it is not part of the per-motel config. The web route uses it
// to verify links; the voice route uses it to strip them (a link can't be spoken).
export const RESERVIT_LINK_RE = /softbooker\.reservit\.com\/reservit\/reserhotel\.php\?[^\s)]+/i;
export const RESERVIT_LINK_RE_G = new RegExp(RESERVIT_LINK_RE.source, "gi");

// Return every Reservit booking link in the text (one per room a multi-type
// group booking would offer). Empty array if none.
export function findAllReservitLinks(text: string): string[] {
  return text.match(RESERVIT_LINK_RE_G) ?? [];
}

// Concatenate the text blocks of a model response into a plain string.
function extractAssistantText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

// Run the model to completion (resolving any check_availability tool calls) and
// return its final text. The tool is ALWAYS offered by default. We used to gate
// it behind a keyword pre-filter as a cost optimization, but that caused real
// bugs: it skipped short confirmations ("ok"/"oui") — letting unverified links
// slip through — and date-only replies ("10 septembre au 13") that carry no
// keyword, forcing the model to promise a check it couldn't perform that turn and
// stalling the conversation. `allowTool` exists ONLY so the web route's
// regenerateHonestReply can withhold the tool while correcting an already-rejected
// link; every normal call leaves it at its default of true.
export async function generateReply(messages: ChatMessageList, allowTool = true): Promise<string> {
  const working: ChatMessageList = [...messages];
  const tools = allowTool ? [CHECK_AVAILABILITY_TOOL] : undefined;

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(motel),
    messages: working,
    tools,
  });

  let rounds = 0;
  while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    working.push({
      role: "assistant",
      // Response content (ContentBlock[]) is typed differently from request
      // content (ContentBlockParam[]); cast when echoing it back.
      content: response.content as unknown as ChatMessageList[number]["content"],
    });

    // Answer EVERY tool_use block in this turn, not just the first. The model can
    // call check_availability multiple times in one turn (e.g. once per room type
    // for a Double + Queen group); the API rejects the next request with a 400 if
    // any tool_use id lacks a matching tool_result.
    const toolResults = await buildToolResults(
      response.content as unknown as Parameters<typeof buildToolResults>[0],
      checkAvailability
    );

    working.push({
      role: "user",
      content: toolResults as unknown as ChatMessageList[number]["content"],
    });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(motel),
      messages: working,
      tools,
    });
  }

  // If we hit the round cap still mid-tool-use, force one final text-only reply.
  if (response.stop_reason === "tool_use") {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(motel),
      messages: working,
    });
  }

  return extractAssistantText(response.content);
}
