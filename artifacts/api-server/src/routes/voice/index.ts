import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getMotelConfig } from "@workspace/motel-config";
import { generateReply } from "../anthropic/chat-brain";
import { findAllReservitLinks } from "../anthropic/reservit-link";
import { checkAvailability } from "../anthropic/availability";
import { sendBookingLinkSms } from "../../lib/sms";
import { maskPhone } from "../../lib/redact";
import { orchestrateBookingSms } from "./booking-sms";
import { sentLinkStore } from "./sent-link-store";
import {
  mapVapiMessages,
  secretMatches,
  extractProvidedSecret,
  toSpokenReply,
  formatSsePayload,
  buildVoiceDebugInfo,
  voiceDebugEnabled,
  DEFAULT_VAPI_SECRET_HEADER,
  type VapiMessage,
} from "./concierge";

// ============================================================================
// Voice channel — Vapi.ai "Custom LLM" endpoint (Phase 2, Blocks A + B/C)
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
// Concierge scope: the agent answers questions and checks availability
// (check_availability runs internally). A booking link is NEVER spoken. When the
// model produces one, orchestrateBookingSms (Bloc B/C) re-verifies availability,
// resolves the guest's number (verified metadata → DTMF keypad), and TEXTS the
// link via Twilio (deduped per call). Only after a successful send does the
// assistant say "I've texted you the link"; on any failure it invites the guest
// to call instead — it must never claim an SMS that did not go out. The shared
// system prompt is intentionally left unchanged (no golden-snapshot change): all
// link-safety and SMS behavior lives in this post-generation layer.
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
    // Normal (always-on) log: numbers are MASKED here so a complete guest number
    // never reaches production logs. The full values stay in local variables for
    // routing/SMS use only. (The opt-in VOICE_DEBUG_LOG block below may expose
    // full numbers by design — it must stay OFF in production.)
    req.log.info(
      { callId, dialedNumber: maskPhone(dialedNumber), callerNumber: maskPhone(callerNumber) },
      "voice: incoming turn"
    );
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

    // Debug capture (opt-in): log a CURATED, secret-free subset — the mapped
    // messages (so we can see "User's Keypad Entry: ..."), caller/dialed numbers,
    // and callId. Built from an explicit allowlist (buildVoiceDebugInfo), so no
    // header, x-vapi-secret, Authorization, SIP identity token, assistant-config
    // echo, or carrier SID can ever reach the logger.
    //
    // PRODUCTION WARNING: this block still logs COMPLETE guest phone numbers and
    // raw message text (incl. keypad-entered numbers). It is gated by
    // voiceDebugEnabled, which requires the flag to be exactly "true" AND
    // NODE_ENV !== "production" — so even a flag accidentally left on cannot leak
    // in production. The always-on logs above are already masked, so normal
    // production logging is safe without this flag.
    if (voiceDebugEnabled(process.env.VOICE_DEBUG_LOG, process.env.NODE_ENV)) {
      req.log.info(
        buildVoiceDebugInfo(body, mapped, callId),
        "voice: curated debug info (VOICE_DEBUG_LOG)"
      );
    }

    // ---- Same brain as web chat ----
    // check_availability runs internally here; Vapi never sees our tools and we
    // never return tool_calls to it.
    const candidate = await generateReply(mapped);

    // ---- Concierge net + SMS orchestration (Bloc B/C) ----
    // A booking link must never be SPOKEN. Two cases:
    //   • No link  → speak the candidate as-is (tool-tags stripped by toSpokenReply).
    //   • Link(s)  → hand off to orchestrateBookingSms, which re-verifies
    //     availability, resolves the guest's number (verified metadata → DTMF),
    //     texts the link via Twilio (deduped per call), and returns a SAFE
    //     spoken reply: the "sent by text" confirmation ONLY after a successful
    //     send, otherwise an invite-to-call. The URL is never spoken.
    const spokenOpts = {
      phone: motel.identity.phone,
      hours: motel.hours.receptionLabel,
    };
    const links = findAllReservitLinks(candidate);
    let reply: string;
    if (links.length === 0) {
      reply = toSpokenReply(candidate, spokenOpts);
    } else {
      const outcome = await orchestrateBookingSms(
        {
          links,
          callId,
          callerNumber,
          messages: mapped,
          motelName: motel.identity.name,
          bookingConfig: { hotelId: motel.booking.hotelId, linkBase: motel.booking.linkBase },
          spokenOpts,
        },
        {
          checkAvailability,
          sendSms: (to, smsBody) => sendBookingLinkSms(to, smsBody, req.log),
          store: sentLinkStore,
        }
      );
      reply = outcome.reply;
      // Structured, secret-free outcome log (no number, no URL, no token).
      req.log.info(
        { callId, smsStatus: outcome.status, smsReason: outcome.smsReason },
        "voice: booking-link SMS outcome"
      );
    }

    if (voiceDebugEnabled(process.env.VOICE_DEBUG_LOG, process.env.NODE_ENV)) {
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
