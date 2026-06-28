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

// Phase 1 (the non-streaming create() call) is the ONLY place the model actually
// has the check_availability tool, so the "call the tool first" directive must
// live only there. Including it in Phase 2 (the streaming call, which has no
// tools array) is what made the model improvise fake <tool_call> text that
// leaked to the guest. Keep this directive out of SYSTEM_PROMPT_BODY.
const AVAILABILITY_TOOL_INSTRUCTION = `## Availability Tool — REQUIRED before any booking link
When you have an exact arrival date, number of nights, and number of adults, and you are about to offer or generate a booking link, call the check_availability tool FIRST. Never claim or imply that specific dates are available without having called this tool — do not guess from memory and do not assume. (See "Responding to an availability check" for how to phrase each possible result.)`;

function buildSystemPrompt(options?: { includeAvailabilityToolInstruction?: boolean }): string {
  const toolInstruction = options?.includeAvailabilityToolInstruction
    ? `\n\n${AVAILABILITY_TOOL_INSTRUCTION}`
    : "";
  return `## CURRENT DATE & TIME (server-injected, Eastern Time — Sherbrooke, Quebec)
Right now it is: ${getCurrentDateContext()}.
This is the ONLY source of truth for "today's date" or "what year is it." You have no other way of knowing the current date — never guess, estimate, or rely on your own sense of time.
If a guest states or implies a different "today" (e.g. "today is the 11th" when it is not), do NOT accept it as fact. Politely correct them using the date above before continuing — never use a guest-asserted date as authoritative for availability or booking calculations without checking it against the date above first.

${SYSTEM_PROMPT_BODY}${toolInstruction}`;
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
Special: In-bedroom glass shower (transparent, open design — perfect for couples)
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
✅ For groups: help them decide how to split, then for 2+ separate rooms direct them to 819-564-9005 to confirm and book together (see Multiple Rooms) — don't hand out multiple "available" links
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

Our availability check only verifies ONE room for one set of dates — it cannot verify availability across MULTIPLE rooms (e.g. a guest wanting 2 or 3 separate rooms of the same or different types). If a guest needs more than one room and you've confirmed how they want to split up, do NOT claim or imply that you've verified availability for all of those rooms, and do NOT generate multiple booking links presented as confirmed/available. Instead, say something concise like: "For multiple rooms, the best way to lock in availability across all of them is to call us at 819-564-9005 — our team can confirm everything at once and get you booked." This applies even if a single-room check happens to come back available — that result only covers one room, not the full group's need. (Single-room bookings are unaffected: keep handling those exactly as usual.)`;

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

// ---- Defense-in-depth: strip tool-call-imitation text from the stream ----
// The real fix for the leak is the Phase 1/Phase 2 prompt split above; this is a
// belt-and-suspenders layer in case the model ever invents some other pseudo
// tool-call syntax. It removes <tool_call>…</tool_call> and
// <tool_response>…</tool_response> blocks (case-insensitive) from the streamed
// text. If it ever fires in production, that's a signal the prompt split didn't
// fully hold — so callers log a warning when stripping occurs.
const TOOL_TAGS = ["<tool_call>", "</tool_call>", "<tool_response>", "</tool_response>"];
const TOOL_OPENING_TAGS = ["<tool_call>", "<tool_response>"];
const LONGEST_TOOL_TAG = Math.max(...TOOL_TAGS.map((t) => t.length));
const COMPLETE_TOOL_BLOCK_RE =
  /<tool_call>[\s\S]*?<\/tool_call>|<tool_response>[\s\S]*?<\/tool_response>/gi;
const DANGLING_CLOSE_TAG_RE = /<\/tool_(?:call|response)>/gi;

// True if `s` is a non-empty prefix of any tool tag (so it could be the start of
// a tag that is still arriving across future deltas).
function isPartialToolTag(s: string): boolean {
  if (!s) return false;
  const lower = s.toLowerCase();
  return TOOL_TAGS.some((tag) => tag.startsWith(lower));
}

// Given the buffered (not-yet-emitted) stream text, return the prefix that is
// safe to send now (`flush`), the suffix to hold for later (`keep`, because it
// is — or might become — a tool tag), and whether a complete block was removed.
function sanitizeStreamBuffer(buffer: string): { flush: string; keep: string; stripped: boolean } {
  let stripped = false;
  const cleaned = buffer.replace(COMPLETE_TOOL_BLOCK_RE, () => {
    stripped = true;
    return "";
  });

  let holdFrom = cleaned.length;

  // Hold from the earliest still-unclosed opening tag (its close may arrive later).
  const lower = cleaned.toLowerCase();
  for (const tag of TOOL_OPENING_TAGS) {
    const idx = lower.indexOf(tag);
    if (idx !== -1 && idx < holdFrom) holdFrom = idx;
  }

  // Hold from the earliest tail position that is a partial tool tag (a tag split
  // across deltas). Such a position can only be within the last (LONGEST-1) chars.
  const scanStart = Math.max(0, cleaned.length - LONGEST_TOOL_TAG);
  for (let p = scanStart; p < holdFrom; p++) {
    if (isPartialToolTag(cleaned.slice(p))) {
      holdFrom = p;
      break;
    }
  }

  return { flush: cleaned.slice(0, holdFrom), keep: cleaned.slice(holdFrom), stripped };
}

// Final pass on whatever text was still held when the stream ended: remove any
// complete blocks, drop a dangling unclosed opening tag (a hallucination cut off
// mid-stream) and any stray close tag.
function finalizeStreamBuffer(buffer: string): { text: string; stripped: boolean } {
  let stripped = false;
  let text = buffer.replace(COMPLETE_TOOL_BLOCK_RE, () => {
    stripped = true;
    return "";
  });

  const lower = text.toLowerCase();
  let cut = -1;
  for (const tag of TOOL_OPENING_TAGS) {
    const idx = lower.indexOf(tag);
    if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
  }
  if (cut !== -1) {
    text = text.slice(0, cut);
    stripped = true;
  }

  text = text.replace(DANGLING_CLOSE_TAG_RE, () => {
    stripped = true;
    return "";
  });

  return { text, stripped };
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

    // ---- PHASE 1: non-streaming tool-decision pass ----
    // Give the model one chance to call check_availability before we stream the
    // guest-facing reply. This whole block is best-effort: if anything throws
    // (the Anthropic call fails, a malformed tool_use block, etc.) we fall through
    // to Phase 2 with the original, unmodified messages so the chat is never
    // broken. Nothing here is written to the SSE stream — from the guest's point
    // of view it's just a slightly longer pause before the reply starts.
    type StreamMessages = Parameters<typeof anthropic.messages.stream>[0]["messages"];
    let messagesForStream: StreamMessages = chatMessages;

    // Skip the Phase 1 round-trip entirely for messages that obviously have
    // nothing to do with booking/dates/occupancy (greetings, policy questions,
    // thanks, etc.). messagesForStream already defaults to chatMessages, so the
    // skip path goes straight to Phase 2 unchanged.
    if (mightInvolveBooking(userContent)) {
      try {
        const toolDecision = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          // Phase 1 is the only call with the tools array, so it's the only one
          // that should carry the "call check_availability first" directive.
          system: buildSystemPrompt({ includeAvailabilityToolInstruction: true }),
          messages: chatMessages,
          tools: [
            {
              name: "check_availability",
              description:
                "Check room availability for specific dates before generating a booking link. Call this whenever the guest has given an exact arrival date, number of nights, and number of adults.",
              input_schema: {
                type: "object",
                properties: {
                  arrivalDate: { type: "string", description: "YYYY-MM-DD" },
                  nights: { type: "integer" },
                  adults: { type: "integer" },
                },
                required: ["arrivalDate", "nights", "adults"],
              },
            },
          ],
        });

        if (toolDecision.stop_reason === "tool_use") {
          const toolUse = toolDecision.content.find((block) => block.type === "tool_use");
          if (toolUse && toolUse.type === "tool_use") {
            const { arrivalDate, nights, adults } = toolUse.input as {
              arrivalDate: string;
              nights: number;
              adults: number;
            };
            const result = await checkAvailability(arrivalDate, nights, adults);

            messagesForStream = [
              ...chatMessages,
              // The SDK types response content (ContentBlock[]) differently from
              // request content (ContentBlockParam[]), so cast when echoing it back.
              {
                role: "assistant",
                content: toolDecision.content as unknown as StreamMessages[number]["content"],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(result),
                  },
                ],
              },
            ];
          }
        }
      } catch (err) {
        // Second safety net around the tool-calling mechanics themselves (in
        // addition to checkAvailability's own check_failed handling): never let a
        // Phase 1 failure break or delay the chat beyond a normal reply.
        req.log.error({ err }, "Availability tool phase failed; continuing without it");
        messagesForStream = chatMessages;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: buildSystemPrompt(),
      messages: messagesForStream,
    });

    // `pending` holds buffered text that might be (the start of) a tool-call tag
    // and so is not yet safe to emit. In normal output it stays tiny — at most a
    // few trailing chars that look like the start of "<tool_call>".
    let pending = "";
    let sanitizationFired = false;

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        pending += event.delta.text;
        const { flush, keep, stripped } = sanitizeStreamBuffer(pending);
        pending = keep;
        if (stripped) sanitizationFired = true;
        if (flush) {
          fullResponse += flush;
          res.write(`data: ${JSON.stringify({ content: flush })}\n\n`);
        }
      }
    }

    // Flush whatever remained held when the stream ended.
    const finalized = finalizeStreamBuffer(pending);
    if (finalized.stripped) sanitizationFired = true;
    if (finalized.text) {
      fullResponse += finalized.text;
      res.write(`data: ${JSON.stringify({ content: finalized.text })}\n\n`);
    }

    if (sanitizationFired) {
      // Defense-in-depth fired: the Phase 1/Phase 2 prompt split should have made
      // this impossible, so if we see this in production, investigate.
      req.log.warn(
        { conversationId },
        "Stripped tool-call-imitation text from streamed response (availability prompt-split defense fired)"
      );
    }

    await db.insert(messages).values(
      insertMessageSchema.parse({ conversationId, role: "assistant", content: fullResponse })
    );

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "Failed to send message");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send message" });
    } else {
      res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
      res.end();
    }
  }
});

export default router;
