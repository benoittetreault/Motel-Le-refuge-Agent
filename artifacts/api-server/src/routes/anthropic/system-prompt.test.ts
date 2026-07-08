import { test } from "node:test";
import assert from "node:assert/strict";
import { motelLeRefuge } from "@workspace/motel-config";
import { buildSystemPrompt } from "./system-prompt";
import { GOLDEN_SYSTEM_PROMPT } from "./system-prompt.golden";

// Compare LF-normalized: git autocrlf gives CRLF on Windows checkouts and LF
// everywhere else; the prompt CONTENT is what must not change.
const lf = (s: string) => s.replace(/\r\n/g, "\n");

// Any date works — the golden holds a {{DATE}} placeholder for the dynamic part.
const FIXED_NOW = new Date("2026-07-08T19:30:00Z");

function formattedFixedDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: motelLeRefuge.identity.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(FIXED_NOW);
}

test("config-driven builder reproduces the golden system prompt exactly", () => {
  const expected = GOLDEN_SYSTEM_PROMPT.replace("{{DATE}}", formattedFixedDate);
  assert.equal(lf(buildSystemPrompt(motelLeRefuge, FIXED_NOW)), lf(expected));
});

test("toneNotes (Layer 3) is injected at the end of Tone & Language Rules only", () => {
  const custom = {
    ...motelLeRefuge,
    personalization: {
      ...motelLeRefuge.personalization,
      toneNotes: "Toujours mentionner notre stationnement gratuit.",
    },
  };
  const prompt = lf(buildSystemPrompt(custom, FIXED_NOW));
  assert.ok(
    prompt.includes(
      "- Overwhelm with choices — suggest naturally and confirm\n\nToujours mentionner notre stationnement gratuit.\n\n## Responding to an availability check"
    )
  );
  // Everything else is untouched: removing the injected block restores the golden output.
  const restored = prompt.replace("\n\nToujours mentionner notre stationnement gratuit.", "");
  assert.equal(restored, lf(buildSystemPrompt(motelLeRefuge, FIXED_NOW)));
});

test("toneNotes beyond the 500-character bound is rejected", () => {
  const tooLong = {
    ...motelLeRefuge,
    personalization: { ...motelLeRefuge.personalization, toneNotes: "x".repeat(501) },
  };
  assert.throws(() => buildSystemPrompt(tooLong, FIXED_NOW), /toneNotes exceeds 500/);
});
