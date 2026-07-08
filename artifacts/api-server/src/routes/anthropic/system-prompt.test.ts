import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_SYSTEM_PROMPT } from "./system-prompt.golden";

// Compare LF-normalized: git autocrlf gives CRLF on Windows checkouts and LF
// everywhere else; the prompt CONTENT is what must not change.
const lf = (s: string) => s.replace(/\r\n/g, "\n");

// Transitional form of this test (pre-refactoring): re-extract the prompt
// literals from index.ts source and assert they match the frozen golden
// fixture. Once buildSystemPrompt() becomes config-driven, this test switches
// to comparing the builder's output against the same golden.
test("golden snapshot matches the live prompt in index.ts", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "index.ts"), "utf8");

  const body = src.match(/const SYSTEM_PROMPT_BODY = `([^`]*)`;/)?.[1];
  const instr = src.match(/const AVAILABILITY_TOOL_INSTRUCTION = `([^`]*)`;/)?.[1];
  const header = src.match(/return `(## CURRENT DATE & TIME[^`]*)`;/)?.[1];
  assert.ok(body, "SYSTEM_PROMPT_BODY literal not found in index.ts");
  assert.ok(instr, "AVAILABILITY_TOOL_INSTRUCTION literal not found in index.ts");
  assert.ok(header, "buildSystemPrompt template literal not found in index.ts");

  // Compose exactly as buildSystemPrompt() does, with {{DATE}} in place of the
  // dynamic date. Replacement functions keep "$" sequences in the prompt text
  // from being interpreted as replacement patterns.
  const full = header
    .replace("${getCurrentDateContext()}", () => "{{DATE}}")
    .replace("${SYSTEM_PROMPT_BODY}", () => body)
    .replace("${AVAILABILITY_TOOL_INSTRUCTION}", () => instr);

  assert.equal(lf(full), lf(GOLDEN_SYSTEM_PROMPT));
});
