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
import { getMotelConfig } from "@workspace/motel-config";
import { eq } from "drizzle-orm";
import { checkAvailability } from "./availability";
import { stripToolTags } from "./strip-tool-tags";
import { buildToolResults } from "./tool-results";
import { buildSystemPrompt } from "./system-prompt";

const router = Router();

const motel = getMotelConfig();

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
// Engine-level pattern (mirrors config.booking.linkBase) — shared by every motel
// on Reservit, so it is not part of the per-motel config.
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
  // Withhold the availability tool here (allowTool=false): we are correcting a
  // link we have already proven invalid, so the model must NOT re-verify and
  // re-propose a link mid-correction. This is the one place the tool is
  // intentionally suppressed — everywhere else it is always offered.
  const regenerated = await generateReply(regenMessages, false);
  const safe = regenerated.replace(RESERVIT_LINK_RE_G, "").replace(/[ \t]{2,}/g, " ").trim();
  return (
    safe ||
    `Malheureusement, ces dates ne sont pas disponibles. Vous pouvez nous appeler au ${motel.identity.phone} et nous trouverons la meilleure option. / Unfortunately those dates aren't available — please call us at ${motel.identity.phone} and we'll find the best option.`
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
// stalling the conversation. `allowTool` exists ONLY so regenerateHonestReply can
// withhold the tool while correcting an already-rejected link (see there); every
// normal call leaves it at its default of true.
async function generateReply(messages: ChatMessageList, allowTool = true): Promise<string> {
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
    // call. The check_availability tool is always offered; the server-side link
    // check below is the real safety net, regardless of whether the model used it.
    const candidate = await generateReply(chatMessages);

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
N'inclus AUCUN lien de réservation dans ta réponse. Réponds au client de façon naturelle et concise, dans sa langue, en suivant la section « Responding to an availability check » du prompt pour le statut « ${result.status} » (et « Multiple Rooms » si plusieurs chambres sont en jeu). Au besoin, invite-le à appeler le ${motel.identity.phone}.`;

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
N'inclus AUCUN lien de réservation dans ta réponse. Réponds au client de façon naturelle et concise, dans sa langue, en suivant la section « Multiple Rooms » du prompt : invite-le à appeler le ${motel.identity.phone} pour que l'équipe confirme et organise l'ensemble.`;

          finalText = await regenerateHonestReply(chatMessages, candidate, correction);
        }
      }
    }

    // Minimal guard on the complete text before sending (defense-in-depth).
    const beforeGuard = finalText;
    const guarded = stripToolTags(finalText);
    if (guarded.stripped) {
      // Log the exact original text so we can see which new tool-syntax variants
      // the model is hallucinating over time (the sanitizer is name-agnostic, so
      // this is our only visibility into emerging shapes).
      req.log.warn(
        { conversationId, original: beforeGuard, cleaned: guarded.text },
        "Stripped tool-call-imitation text from final reply"
      );
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
