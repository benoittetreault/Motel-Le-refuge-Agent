import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getMotelConfig } from "@workspace/motel-config";
import { generateReply } from "../anthropic/chat-brain";
import { findAllReservitLinks } from "../anthropic/reservit-link";
import {
  mapVapiMessages,
  secretMatches,
  extractProvidedSecret,
  toSpokenReply,
  formatSsePayload,
  DEFAULT_VAPI_SECRET_HEADER,
  type VapiMessage,
} from "./concierge";

// ============================================================================
// Voice channel — Vapi.ai "Custom LLM" endpoint (Phase 2, Block A)
// ----------------------------------------------------------------------------
// Vapi handles the telephony (ASR + TTS). Configured in "Custom LLM" mode, it
// POSTs an OpenAI-compatible /chat/completions body to us on every turn, with
// its call metadata merged in. We run the SAME brain as the web chat
// (generateReply). Vapi always sends stream:true and only speaks a reply
// delivered as an OpenAI SSE stream — a plain JSON body leaves it silent — so we
// answer in SSE. Crucially we do NOT stream the GENERATION: generateReply still
// runs to completion and the concierge net verifies the FULL text first; we only
// wrap that finished, already-verified reply as SSE (see the response below).
//
// Concierge scope for Block A: the agent answers questions and checks
// availability (check_availability runs normally, internally), but NEVER speaks
// a booking link. If the (web) prompt still produces one, we replace the reply
// with an invitation to call the motel. A voice-specific prompt comes in Block
// B; SMS booking links come in Block C.
// ============================================================================

const router = Router();

// The exact request shape is confirmed from a real Vapi payload before being
// relied on (see VOICE_DEBUG_LOG below); everything here is read defensively.
interface VapiChatBody {
  model?: string;
  messages?: VapiMessage[];
  call?: {
    id?: string;
    // The number the guest DIALED (identifies the motel — multi-motel key).
    phoneNumber?: { number?: string };
    // The guest's own number (the caller).
    customer?: { number?: string };
  };
}

const VAPI_SECRET = process.env.VAPI_SECRET;
const VAPI_SECRET_HEADER = process.env.VAPI_SECRET_HEADER ?? DEFAULT_VAPI_SECRET_HEADER;

// Shared handler for both route aliases (see registration below).
const handleVoiceChat: import("express").RequestHandler = async (req, res) => {
  try {
    const body = req.body as VapiChatBody;

    // Debug capture (opt-in): log the raw body AND headers BEFORE any processing
    // — this is how we confirm the exact call.phoneNumber.number path and the
    // auth header name on the first real test call. Off by default; headers may
    // contain the shared secret, so only enable this on a controlled test.
    if (process.env.VOICE_DEBUG_LOG === "true") {
      req.log.info(
        { rawHeaders: req.headers, rawBody: body },
        "voice: raw Vapi payload (VOICE_DEBUG_LOG)"
      );
    }

    // ---- Auth: shared secret ----
    if (!VAPI_SECRET) {
      // Not configured — allow in dev, but make the gap loud (same spirit as the
      // mailer skipping when SMTP isn't set).
      req.log.warn("voice: VAPI_SECRET not set — accepting request without auth (dev only)");
    } else {
      const provided = extractProvidedSecret(
        req.headers as Record<string, unknown>,
        VAPI_SECRET_HEADER
      );
      if (!provided || !secretMatches(provided, VAPI_SECRET)) {
        req.log.warn("voice: rejected request with missing/invalid Vapi secret");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    // ---- Identify the motel from the dialed number (multi-motel foundation) ----
    const dialedNumber = body.call?.phoneNumber?.number;
    const callerNumber = body.call?.customer?.number;
    const callId = body.call?.id;
    req.log.info({ callId, dialedNumber, callerNumber }, "voice: incoming turn");
    // getMotelConfig ignores dialedNumber for now (single motel) but the wiring
    // is in place for when it resolves per-number.
    const motel = getMotelConfig(dialedNumber);

    // ---- Validate + map history ----
    if (!Array.isArray(body.messages)) {
      res.status(400).json({ error: "Invalid request: messages[] required" });
      return;
    }
    const mapped = mapVapiMessages(body.messages);
    if (mapped.length === 0) {
      res.status(400).json({ error: "Invalid request: no user/assistant messages" });
      return;
    }

    // ---- Same brain as web chat ----
    // check_availability runs internally here; Vapi never sees our tools and we
    // never return tool_calls to it.
    const candidate = await generateReply(mapped);

    // ---- Concierge net: a booking link must never be spoken ----
    const reply = toSpokenReply(candidate, {
      phone: motel.identity.phone,
      hours: motel.hours.receptionLabel,
    });
    if (findAllReservitLinks(candidate).length > 0) {
      req.log.info({ callId }, "voice: booking link present — replaced with invite-to-call");
    }

    if (process.env.VOICE_DEBUG_LOG === "true") {
      req.log.info({ callId, reply }, "voice: outgoing spoken reply (VOICE_DEBUG_LOG)");
    }

    // ---- Respond as OpenAI SSE (chat.completion.chunk) ----
    // Vapi only speaks a reply delivered as a streaming SSE response; a plain
    // JSON body leaves it silent. The reply is already complete and verified —
    // we simply wrap it as SSE (single content chunk), so no logic or safety
    // changes upstream. Error paths above already returned JSON before we get
    // here, so no SSE headers were set on those.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(
      formatSsePayload(reply, {
        id: `chatcmpl-${callId ?? randomUUID()}`,
        model: body.model ?? "custom-llm",
        created: Math.floor(Date.now() / 1000),
      })
    );
    res.end();
  } catch (err) {
    req.log.error({ err }, "voice: failed to handle turn");
    res.status(500).json({ error: "Failed to handle voice turn" });
  }
};

// Register the same handler under both conventions Vapi may use for the Custom
// LLM URL: the exact path given as-is ("/chat"), or an OpenAI-style base URL to
// which Vapi appends "/chat/completions".
router.post("/chat", handleVoiceChat);
router.post("/chat/completions", handleVoiceChat);

export default router;
