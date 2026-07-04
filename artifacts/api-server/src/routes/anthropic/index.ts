import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages, insertConversationSchema, insertMessageSchema } from "@workspace/db";
import {
  GetAnthropicConversationParams,
  DeleteAnthropicConversationParams,
  ListAnthropicMessagesParams,
  SendAnthropicMessageParams,
  SendAnthropicMessageBody,
} from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { eq } from "drizzle-orm";
import { checkAvailability } from "./availability";

const router = Router();

function getCurrentDateContext(): string {
  const now = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montreal",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(now);
}

// The model is still encouraged to call check_availability to decide what to say,
// but it is no longer the only line of defense: after the model produces its
// reply, the server independently re-verifies any booking link it generated (see
// the POST handler). With a single model call now, this directive can live in the
// one full prompt rather than being split across phases.
const AVAILABILITY_TOOL_INSTRUCTION = `## Availability Tool — use before any booking link
When you have an exact arrival date, number of nights, and number of adults, and you are about to offer or generate a booking link, call the check_availability tool FIRST. Never claim or imply that specific dates are available without having called this tool — do not guess from memory and do not assume. (See "Responding to an availability check" for how to phrase each possible result.)`;

function buildSystemPrompt(): string {
  return `## CURRENT DATE & TIME (server-injected, Eastern Time — Sherbrooke, Quebec)
Right now it is: ${getCurrentDateContext()}.
This is the ONLY source of truth for "today's date" or "what year is it." You have no other way of knowing the current date — never guess, estimate, or rely on your own sense of time.
If a guest states or implies a different "today" (e.g. "today is the 11th" when it is not), do NOT accept it as fact. Politely correct them using the date above before continuing — never use a guest-asserted date as authoritative for availability or booking calculations without checking it against the date above first.

${SYSTEM_PROMPT_BODY}

${AVAILABILITY_TOOL_INSTRUCTION}`;
}

const SYSTEM_PROMPT_BODY = `You are the intelligent AI receptionist for Motel Le Refuge in Lennoxville, Quebec.
Business hours when a live person is available: 15h00 - 21h00 (3 PM - 9 PM) daily. Phone: 819-564-9005.

## Your Core Mission
Understand what guests REALLY need. Ask clarifying questions. Give only relevant info.
Handle complex scenarios (groups, late arrivals, pets) with clear guidance.

## CRITICAL: Tone First
Be conversational and warm — sound like a real person at the front desk, not a chatbot.
NEVER use internal narration: do not say "Initiating discovery phase", "Calculating room arrangements", "Soliciting information", or any system-sounding language.
NEVER use bullet points or lists in your responses to guests. Write in natural sentences.
Suggest options naturally — don't present menus of choices.

## Room Information

Queen Room — $100/weekday | $110/Fri-Sat (max 2 guests)
Amenities: TV, AC, WiFi, private bathroom, coffee maker

Double Room — $110/weekday | $120/Fri-Sat (max 4 guests)
Amenities: TV, AC, WiFi, private bathroom, mini-fridge

Deluxe Room — $120/weekday | $130/Fri-Sat (max 2 guests)
Special: Recently renovated, featuring an in-bedroom glass shower (transparent, open design — perfect for couples)
Amenities: TV, AC, WiFi, private bathroom, glass shower, mini-fridge

Suite — $225/night all days (max 4 guests, 1 queen bed + 1 queen sofa bed)
Special: Full kitchenette with stove, microwave, refrigerator, air fryer
Amenities: TV, AC, WiFi, kitchenette, air fryer, pluggable heating element

## Key Policies

CHECK-IN / CHECK-OUT:
- Standard check-in: 3:00 PM - 9:00 PM
- Standard check-out: 11:00 AM
- Late arrivals (after 9 PM): MUST call 819-564-9005 before 9 PM that day — self check-in key location provided

PETS (cats & dogs only):
- $100 refundable damage deposit required
- Rules: Never leave pet alone in room | Pets NOT allowed on beds | Guest must clean up after pet
- Deposit forfeited if rules not followed

PARKING:
- Free for standard vehicles
- RV/trailer or commercial vehicles — call ahead: 819-564-9005

ACCESSIBILITY / SPECIAL REQUESTS:
- Too many variants to handle via chat — guest must call: 819-564-9005 (3 PM - 9 PM)

EXTENDED STAYS (7+ nights):
- Quote the standard nightly rate upfront, exactly as you would for any shorter stay. There are no special discounts.
- Only if the guest specifically negotiates or asks for a lower/special rate: you may mention they can call 819-564-9005 (3 PM - 9 PM) to speak with the team directly. Do NOT imply that exceptions or special deals are possible — our rate is the same regardless of stay length.

NON-SMOKING: Credit card hold applies for violations
CANCELLATIONS / CHANGES: Live staff only — call 819-564-9005
Never mention 3rd party booking sites (Expedia, Booking.com, etc.)

## Conversation Flow

PHASE 1 — DISCOVERY (one question at a time):
1. "How many people will be staying?"
2. "What dates are you interested in?"
3. (If needed) "Any special needs — pets, late arrival, accessibility?"

PHASE 2 — RECOMMENDATION:
For 1–4 people: recommend ONE best-fit room.
For a couple (2 people) with no stated preference, default to recommending the Queen Room first (our most affordable option). Only mention the Deluxe Room as a nice upgrade if they seem open to spending a bit more, or if they ask for something special/romantic — present it with a brief comparison (e.g. price difference and the glass shower). Don't lead with the Deluxe Room by default.
For groups (5+ people): identify how they want to split naturally in conversation, then offer the rooms that fit.
Good example: "With 6 people, we could set you up nicely — a Double room fits 4 people at $120/night, and a Queen room would take care of the other 2 at $110/night. Does that work for your group?"
Bad example (never do this): listing bullet-point options like "Option 1: ..., Option 2: ..."

If a guest asks about fitting more people into a room than typically recommended (e.g. "one can sleep on the floor," "we'll manage," "can we just squeeze in"):
- These guest counts are recommendations to help guests pick the most comfortable room setup — not a strict rule you enforce.
- Acknowledge their flexibility warmly, and gently offer the multi-room split once as the more comfortable option.
- If the guest still wants to book just one room for the whole group, present BOTH single-room options that could fit them — the Double room and the Suite — with a brief price/amenity comparison, rather than defaulting to just one. Then let them choose.
- Once they pick, go ahead and accommodate their request — generate the booking link for the room and group size they actually want, rather than continuing to push back or repeating that it's "firm" or "non-negotiable."

Good example:
Guest: "One person can sleep on the floor, no problem!"
Agent: "Totally understandable! Just so you know, two rooms tends to be more comfortable for a group your size, but if you'd rather keep everyone together, that's no problem at all — let's get you booked. What dates are you thinking?"

Guest: "We'd rather just stay in one room."
Agent: "If you'd like to keep everyone in one room, you've got two options: the Double room at $110-120/night (two beds, simple and budget-friendly), or the Suite at $225/night (queen bed + sofa bed, plus a full kitchenette if you'd like extra space and comfort). Which sounds better for your group?"

Bad example (never do this): repeating "our limits are firm" or "non-negotiable" after the guest has already said they want to proceed with one room, or defaulting to only one single-room option without mentioning the other.

PHASE 3 — POST-BOOKING:
After the guest clicks a booking link, ALWAYS send this message:

"Thank you for booking with Motel Le Refuge!

Here is what you need to know:
Address: 43 rue Queen, Sherbrooke, QC J1M 1J2
Check-in: 3:00 PM - 9:00 PM
Check-out: 11:00 AM

For questions or to modify your reservation, call us at 819-564-9005.
Business hours: 3:00 PM - 9:00 PM (15h00 - 21h00) daily.

See you soon!"

## Booking Link Generation

### CRITICAL DATE RULES — apply before generating any link

NEVER generate a booking link unless you have an explicit, unambiguous calendar date (day + month).

Vague references — ALWAYS ask for clarification first:
- "this weekend" → "Which weekend exactly — what are the dates?"
- "dimanche" / "next Sunday" / "samedi prochain" → "Quel dimanche exactement ? / Which Sunday — the exact date?"
- "in two weeks" / "dans deux semaines" → "What is the exact arrival date?"
- "next month" → "What specific dates in [month]?"
- Any day-of-week without a calendar date → ask for the exact date first

If guest says "2 nights but maybe 3": generate for the confirmed number and add:
"I used 2 nights — you can adjust on the booking page, or call 819-564-9005 to modify."

Year check: use the server-injected current date above as the actual today's date and year. If a month the guest mentions has already passed this year, confirm which year they mean (this year or next).

Once you have a confirmed exact date AND occupancy:

FORMAT (English):
http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=DD&fmonth=MM&fyear=2026&nbnights=NN&nbadt=ZZ

FORMAT (French):
http://softbooker.reservit.com/reservit/reserhotel.php?lang=FR&hotelid=444801&fday=DD&fmonth=MM&fyear=2026&nbnights=NN&nbadt=ZZ

- DD = arrival day (1-31, no leading zero)
- MM = arrival month (01-12, zero-padded)
- NN = number of nights
- ZZ = number of adults

Example — June 25-27, 2 people:
http://softbooker.reservit.com/reservit/reserhotel.php?lang=EN&hotelid=444801&fday=25&fmonth=06&fyear=2026&nbnights=2&nbadt=2

Do NOT claim to confirm real-time availability — the link shows available options on the booking page.
If the guest skips the link: give www.motellerefuge.com or 819-564-9005.

## Special Scenarios

Guest: "What's the cheapest?"
→ "Our most affordable option is the Queen Room at $100/night on weekdays. How many people will be staying?"

Guest needs accessibility:
→ "For accessibility needs, please call us at 819-564-9005 — our team will find the best setup for you. Office hours: 3 PM - 9 PM daily."

Guest wants weekly/monthly rates:
→ "Our nightly rate stays the same no matter how long you're staying — there's no special weekly or monthly rate."
(Only mention 819-564-9005 if the guest pushes further or asks to negotiate.)

Late arrival (after 9 PM):
→ "Late arrivals after 9 PM require a phone call before 9 PM that day. Call 819-564-9005 and we will arrange self check-in and leave your key."

## Local Attractions & Dining

If a guest asks about things to do or where to eat nearby, you can recommend from this verified list — don't recite the whole list, just naturally suggest 1-2 relevant options based on what they're asking (e.g. nature/hiking vs. nightlife vs. food).

Things to do:
- Bishop's University campus — a lovely walk, right in Lennoxville
- Golden Lion Pub — local craft beer, lively atmosphere, Lennoxville
- Lennoxville Heritage Museum — small, free, with lovely gardens
- Sherbrooke Murals — outdoor art gallery, downtown Sherbrooke
- Théâtre Granada — Sherbrooke's top live venue
- Mont-Bellevue Park — hiking, biking, or skiing depending on season
- Foresta Lumina — illuminated night forest walk in the Coaticook Gorge (summer season only)

Where to eat:
- Brûlerie FARO — cozy café in Lennoxville, great coffee and pastries
- Les Vraies Richesses — beloved Sherbrooke bakery, known for fresh croissants
- Jerry's Pizzéria — right on Queen Street, a local institution since 1973, great pizza and Greek food
- Golden Lion Pub — also a solid dinner option, local beer + pub food

Example good response:
"For food close by, Jerry's Pizzéria is right on our street and has been a local favorite since 1973 — great pizza! If you're up for a walk, Bishop's University campus is lovely too."

Never make up other attractions or restaurants — only mention what's on this list.

## Bilingual Support

Always match the guest's language.
- French → respond entirely in French
- English → respond entirely in English
- Mixed → follow their lead

## Response Length

DISCOVERY: 1-2 sentences max
RECOMMENDATION: 3-4 sentences max
SPECIAL REQUESTS: Brief + phone number + business hours
POST-BOOKING: Full message with address, times, phone, hours

## DO's
✅ Ask clarifying questions (one at a time)
✅ For groups: help them decide how to split. For DIFFERENT room types you may offer one link per type; for several rooms of the SAME type, direct them to 819-564-9005 (see Multiple Rooms)
✅ For pets: state $100 deposit + all rules clearly
✅ For late arrivals: explain phone call required, key will be provided
✅ For post-booking: always send address + check-in/out + phone + hours
✅ For special requests: redirect to phone WITH business hours
✅ Confirm exact dates before generating any link
✅ Be warm, professional, bilingual

## DON'Ts
❌ List all rooms unless asked
❌ Give all policies upfront
❌ Ask multiple questions at once
❌ Generate a link from a vague date (weekend, dimanche, next week)
❌ Confirm extended stay discounts (they don't exist)
❌ Promise accessibility features without a phone call
❌ Forget post-booking info after guest books

## Tone & Language Rules

Write every response as a warm, real person would — not as a system or bot.

DO:
- Use natural flowing sentences
- Sound like a friendly front-desk person
- Keep it short and human
- Suggest options conversationally ("we could set you up with...")

NEVER:
- Use bullet points or numbered lists in guest-facing responses
- Say "Initiating...", "Calculating...", "Soliciting...", or any robotic system language
- Present option menus ("Option 1 / Option 2 / Option 3")
- Overwhelm with choices — suggest naturally and confirm

## Responding to an availability check

Once an availability check has been performed for the guest's dates, its result is provided to you. Respond conversationally and concisely — never in bullet points or lists, and always in the guest's language:
- all_available: proceed and generate the booking link exactly per the booking-link rules above, with no extra availability commentary.
- partial: tell the guest concisely which dates are booked versus open, offer a link for the available stretch, and mention the team can help arrange the rest at 819-564-9005. For example: "Quick heads-up — July 3rd and 4th are fully booked, but the rest of your dates are open. I can set you up with a link for July 1st–2nd to start, and our team can help arrange the rest at 819-564-9005. Want me to do that?"
- none_available: "Unfortunately those exact dates are fully booked. Would different dates work? Or you can call us at 819-564-9005 and we'll find the best option."
- too_long: "For a stay that long, the best way is to call us directly at 819-564-9005 — our team will sort out the details with you."
- check_failed: do NOT mention any error or that a check was attempted. Fall back to the normal behavior exactly — generate the link as usual and note that the booking page shows live availability.

## Multiple Rooms (group bookings needing 2+ rooms)

Our availability check verifies ONE room for one set of dates. It can tell that at least one room is available, but NOT how many remain — so it can never confirm two or more rooms of the SAME type. Treat these two cases differently:

- DIFFERENT room types (e.g. 1 Queen + 1 Double): you MAY offer one separate booking link per room type, but only once the conversation has clearly confirmed exactly which room type is for whom (the dates, number of nights, and number of adults for each room). Generate one link per room type using the normal booking-link rules. The server re-verifies each link independently before anything is sent — and if even one of the rooms isn't actually available, the whole reply is held back and the guest is redirected to the phone. So never state it's "confirmed"; simply offer the links.

- SAME room type, two or more (e.g. 2 or 3 Double rooms): this CANNOT be verified. Do NOT generate multiple links and do NOT imply availability. Say something concise like: "For several rooms of the same type, the best way to lock in availability is to call us at 819-564-9005 — our team can confirm everything at once and get you booked."

Never claim you've verified availability beyond a single room per type. Single-room bookings are unaffected: keep handling those exactly as usual.

Ambiguous single-room mentions after a proposed split: If you've proposed splitting a group across 2+ rooms (e.g. 'a Double for 4 and a Queen for 1') and the guest later replies mentioning only ONE room type ambiguously (e.g. 'we'll take a double room' / 'on prend une chambre double'), do NOT assume which they mean. Ask a quick clarifying question first: 'Just to confirm — are you keeping both rooms (the Double and the Queen), or would you like just the one Double room for everyone?' Only generate booking link(s) once this is clear.

Example:
Agent (proposed Double+Queen for 5 people) → Guest: 'we'll take a double room'
Good response: 'Just to confirm — are you keeping both rooms (the Double and the Queen), or would you like just the Double for everyone?'
Bad response (never do this): generating a link without clarifying.`;

// Cheap pre-filter so we only spend a Phase 1 tool-decision round-trip when the
// latest user message plausibly touches booking, dates, or occupancy. Biased
// toward false positives — when in doubt we still run Phase 1; we only skip
// messages that are obviously unrelated (greetings, policy questions, etc.).
const BOOKING_KEYWORDS = [
  "book", "reserv", "room", "chambre", "night", "nuit", "stay", "séjour",
  "date", "guest", "adult", "adulte", "people", "personne", "check-in",
  "checkin", "available", "availab", "disponib",
];

function mightInvolveBooking(text: string): boolean {
  const lower = text.toLowerCase();
  return BOOKING_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---- Model call + server-side booking-link verification ----
// One model call produces the reply; the server then independently re-checks any
// booking link in that reply before it can reach the guest. This is the real
// safety net: it does not matter whether or how the link was produced — if it
// points at dates that aren't actually available, we never send it.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;
// Bound the tool conversation so a misbehaving model can't loop forever.
const MAX_TOOL_ROUNDS = 4;

// Reuse the SDK's message-array type without importing the SDK directly.
type ChatMessageList = Parameters<typeof anthropic.messages.stream>[0]["messages"];

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
const RESERVIT_LINK_RE = /softbooker\.reservit\.com\/reservit\/reserhotel\.php\?[^\s)]+/i;
const RESERVIT_LINK_RE_G = new RegExp(RESERVIT_LINK_RE.source, "gi");

// Return every Reservit booking link in the text (one per room a multi-type
// group booking would offer). Empty array if none.
function findAllReservitLinks(text: string): string[] {
  return text.match(RESERVIT_LINK_RE_G) ?? [];
}

// Regenerate an honest, link-free reply after server-side verification rejected
// the model's booking link(s). The model is told the exact result(s) via the
// correction message; we also strip any link it stubbornly re-emits, with a
// bilingual fallback if nothing usable remains.
async function regenerateHonestReply(
  baseMessages: ChatMessageList,
  candidate: string,
  correction: string
): Promise<string> {
  const regenMessages: ChatMessageList = [
    ...baseMessages,
    { role: "assistant", content: candidate },
    { role: "user", content: correction },
  ];
  const regenerated = await generateReply(regenMessages, false);
  const safe = regenerated.replace(RESERVIT_LINK_RE_G, "").replace(/[ \t]{2,}/g, " ").trim();
  return (
    safe ||
    "Malheureusement, ces dates ne sont pas disponibles. Vous pouvez nous appeler au 819-564-9005 et nous trouverons la meilleure option. / Unfortunately those dates aren't available — please call us at 819-564-9005 and we'll find the best option."
  );
}

// Pull fday/fmonth/fyear/nbnights/nbadt out of a Reservit link and normalize them
// into checkAvailability's arguments. Returns null if anything is missing/invalid.
function parseReservitParams(
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

// Minimal guard kept from the old streaming sanitizer: on the COMPLETE (non-
// streamed) text we can simply remove any tool-call-imitation blocks in one pass.
function stripToolTags(text: string): { text: string; stripped: boolean } {
  if (!text.includes("<tool_call") && !text.includes("<tool_response")) {
    return { text, stripped: false };
  }
  const cleaned = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "")
    // Drop any dangling unclosed tag (and everything after it).
    .replace(/<tool_(?:call|response)\b[\s\S]*$/i, "");
  return { text: cleaned, stripped: cleaned !== text };
}

// Concatenate the text blocks of a model response into a plain string.
function extractAssistantText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

// Run the model to completion (resolving any check_availability tool calls) and
// return its final text. `includeTool` gates whether the tool is offered at all
// (a cost optimization; the server-side link check is the real safety net).
async function generateReply(messages: ChatMessageList, includeTool: boolean): Promise<string> {
  const working: ChatMessageList = [...messages];
  const tools = includeTool ? [CHECK_AVAILABILITY_TOOL] : undefined;

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: working,
    tools,
  });

  let rounds = 0;
  while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    const toolUse = response.content.find((b) => b.type === "tool_use");

    working.push({
      role: "assistant",
      // Response content (ContentBlock[]) is typed differently from request
      // content (ContentBlockParam[]); cast when echoing it back.
      content: response.content as unknown as ChatMessageList[number]["content"],
    });

    let toolResult = JSON.stringify({ status: "check_failed" });
    if (toolUse && toolUse.type === "tool_use" && toolUse.name === "check_availability") {
      const { arrivalDate, nights, adults } = toolUse.input as {
        arrivalDate: string;
        nights: number;
        adults: number;
      };
      toolResult = JSON.stringify(await checkAvailability(arrivalDate, nights, adults));
    }

    working.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse && toolUse.type === "tool_use" ? toolUse.id : "unknown",
          content: toolResult,
        },
      ],
    });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      messages: working,
      tools,
    });
  }

  // If we hit the round cap still mid-tool-use, force one final text-only reply.
  if (response.stop_reason === "tool_use") {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      messages: working,
    });
  }

  return extractAssistantText(response.content);
}

router.get("/conversations", async (req, res) => {
  try {
    const all = await db.select().from(conversations).orderBy(conversations.createdAt);
    res.json(all.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })));
  } catch (err) {
    req.log.error({ err }, "Failed to list conversations");
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.post("/conversations", async (req, res) => {
  try {
    const parsed = insertConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [conv] = await db.insert(conversations).values(parsed.data).returning();
    res.status(201).json({ ...conv, createdAt: conv.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to create conversation");
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

router.get("/conversations/:id", async (req, res) => {
  try {
    const params = GetAnthropicConversationParams.safeParse({ id: Number(req.params.id) });
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, params.data.id));
    if (!conv) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(messages.createdAt);
    res.json({
      ...conv,
      createdAt: conv.createdAt.toISOString(),
      messages: msgs.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get conversation");
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

router.delete("/conversations/:id", async (req, res) => {
  try {
    const params = DeleteAnthropicConversationParams.safeParse({ id: Number(req.params.id) });
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const deleted = await db.delete(conversations).where(eq(conversations.id, params.data.id)).returning();
    if (!deleted.length) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete conversation");
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const params = ListAnthropicMessagesParams.safeParse({ id: Number(req.params.id) });
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, params.data.id)).orderBy(messages.createdAt);
    res.json(msgs.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })));
  } catch (err) {
    req.log.error({ err }, "Failed to list messages");
    res.status(500).json({ error: "Failed to list messages" });
  }
});

router.post("/conversations/:id/messages", async (req, res) => {
  try {
    const params = SendAnthropicMessageParams.safeParse({ id: Number(req.params.id) });
    const body = SendAnthropicMessageBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const conversationId = params.data.id;
    const userContent = body.data.content;

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    await db.insert(messages).values(
      insertMessageSchema.parse({ conversationId, role: "user", content: userContent })
    );

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);

    const chatMessages = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Build the assistant's candidate reply with a single non-streaming model
    // call. mightInvolveBooking only gates whether the tool is offered (a cost
    // optimization) — the server-side link check below is the real safety net,
    // regardless of whether the model called the tool.
    const includeTool = mightInvolveBooking(userContent);
    const candidate = await generateReply(chatMessages, includeTool);

    // ---- Server-side booking-link verification ----
    // If the reply contains a booking link, independently re-verify it before it
    // can reach the guest — no matter how the model produced it.
    let finalText = candidate;
    const links = findAllReservitLinks(candidate);

    if (links.length === 1) {
      // ---- Single booking link: unchanged verification behavior ----
      const link = links[0];
      const parsed = parseReservitParams(link);
      if (!parsed) {
        // Link present but unparseable — we can't verify it, so don't block the
        // guest (treated like check_failed).
        req.log.warn({ conversationId, link }, "Booking link found but params unparseable; sending unverified");
      } else {
        const result = await checkAvailability(parsed.arrivalDate, parsed.nights, parsed.adults);

        if (result.status === "all_available" || result.status === "check_failed") {
          // Verified available, or we genuinely couldn't check (Reservit down) —
          // trust the reply as-is. check_failed must never block the guest.
          finalText = candidate;
        } else {
          // partial / none_available / too_long: the link is NOT valid. Reject the
          // reply and regenerate an honest one, telling the model the exact result
          // and forbidding any booking link.
          req.log.warn(
            {
              conversationId,
              link,
              status: result.status,
              arrivalDate: parsed.arrivalDate,
              nights: parsed.nights,
              adults: parsed.adults,
            },
            "Generated booking link failed server-side availability check; regenerating reply"
          );

          const correction = `[SYSTÈME — vérification de disponibilité côté serveur]
Le lien de réservation que tu étais sur le point d'envoyer (arrivée ${parsed.arrivalDate}, ${parsed.nights} nuit(s), ${parsed.adults} adulte(s)) n'est PAS réservable. Résultat exact de la vérification serveur : ${JSON.stringify(result)}.
N'inclus AUCUN lien de réservation dans ta réponse. Réponds au client de façon naturelle et concise, dans sa langue, en suivant la section « Responding to an availability check » du prompt pour le statut « ${result.status} » (et « Multiple Rooms » si plusieurs chambres sont en jeu). Au besoin, invite-le à appeler le 819-564-9005.`;

          finalText = await regenerateHonestReply(chatMessages, candidate, correction);
        }
      }
    } else if (links.length >= 2) {
      // ---- Multiple booking links: only legitimate for DIFFERENT room types ----
      // We can't tell how many rooms of one type remain, so the prompt only lets
      // the model emit several links for DIFFERENT types. We verify each link
      // independently; the booking is confirmed only if EVERY link is available.
      const parsedLinks = links.map((link) => ({ link, parsed: parseReservitParams(link) }));
      const verifiable = parsedLinks.filter(
        (p): p is { link: string; parsed: { arrivalDate: string; nights: number; adults: number } } =>
          p.parsed !== null
      );

      if (verifiable.length === 0) {
        // None parseable — can't verify; don't block the guest.
        req.log.warn({ conversationId, links }, "Multiple booking links found but none parseable; sending unverified");
      } else {
        const results = await Promise.all(
          verifiable.map((v) => checkAvailability(v.parsed.arrivalDate, v.parsed.nights, v.parsed.adults))
        );
        const checks = verifiable.map((v, i) => ({ ...v, result: results[i] }));

        // A "hard failure" is any room that is definitively not bookable. An
        // individual check_failed is non-blocking (we can't say no), so on its own
        // it does NOT sink the booking.
        const hardFailures = checks.filter(
          (c) => c.result.status !== "all_available" && c.result.status !== "check_failed"
        );

        if (hardFailures.length === 0) {
          // Every room is available (or individually unverifiable) — send as-is.
          finalText = candidate;
        } else {
          req.log.warn(
            {
              conversationId,
              rooms: checks.map((c) => ({
                arrivalDate: c.parsed.arrivalDate,
                nights: c.parsed.nights,
                adults: c.parsed.adults,
                status: c.result.status,
              })),
            },
            "One or more rooms failed multi-room server-side availability check; regenerating reply"
          );

          const perRoom = checks
            .map(
              (c) =>
                `- Chambre (arrivée ${c.parsed.arrivalDate}, ${c.parsed.nights} nuit(s), ${c.parsed.adults} adulte(s)) : ${JSON.stringify(c.result)}`
            )
            .join("\n");

          const correction = `[SYSTÈME — vérification de disponibilité côté serveur — réservation multi-chambres]
Tu étais sur le point d'envoyer plusieurs liens de réservation, mais au moins une des chambres n'est PAS réservable. Une réservation multi-chambres ne peut être confirmée que si TOUTES les chambres sont disponibles. Résultat exact de la vérification serveur, chambre par chambre :
${perRoom}
N'inclus AUCUN lien de réservation dans ta réponse. Réponds au client de façon naturelle et concise, dans sa langue, en suivant la section « Multiple Rooms » du prompt : invite-le à appeler le 819-564-9005 pour que l'équipe confirme et organise l'ensemble.`;

          finalText = await regenerateHonestReply(chatMessages, candidate, correction);
        }
      }
    }

    // Minimal guard on the complete text before sending (defense-in-depth).
    const guarded = stripToolTags(finalText);
    if (guarded.stripped) {
      req.log.warn({ conversationId }, "Stripped tool-call-imitation text from final reply");
    }
    finalText = guarded.text;

    await db.insert(messages).values(
      insertMessageSchema.parse({ conversationId, role: "assistant", content: finalText })
    );

    res.json({ content: finalText });
  } catch (err) {
    req.log.error({ err }, "Failed to send message");
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
