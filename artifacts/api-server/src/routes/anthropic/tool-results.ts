// Build the tool_result blocks that answer a model turn's tool calls.
//
// The model may emit SEVERAL tool_use blocks in a single turn (parallel tool
// use) — e.g. one check_availability per room type when confirming a Double +
// Queen split for a group. The Anthropic API requires that EVERY tool_use id be
// followed by a matching tool_result; if even one is missing, the next request
// fails with 400 "tool_use ids were found without tool_result blocks immediately
// after". The previous code answered only the first tool_use (via `.find()`),
// which is exactly what broke multi-room bookings in production.
//
// This helper answers ALL of them: it runs the availability check for each
// check_availability call in parallel (order preserved so each result lines up
// with its own tool_use_id), and emits a `check_failed` fallback for any tool_use
// block that is not a check_availability call — guaranteeing every single
// tool_use receives a response, without exception.

// Minimal structural types so this module stays dependency-free (no SDK import)
// and unit-testable in isolation.
export interface ToolUseLike {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type RunCheck = (
  arrivalDate: string,
  nights: number,
  adults: number
) => Promise<unknown>;

export async function buildToolResults(
  content: ReadonlyArray<ToolUseLike>,
  runCheck: RunCheck
): Promise<ToolResultBlock[]> {
  const toolUses = content.filter((block) => block.type === "tool_use");

  // Promise.all over .map preserves array order, so result[i] corresponds to
  // toolUses[i] — and each block carries its own tool_use_id regardless.
  return Promise.all(
    toolUses.map(async (block): Promise<ToolResultBlock> => {
      let result: unknown = { status: "check_failed" };

      if (block.name === "check_availability") {
        const { arrivalDate, nights, adults } = (block.input ?? {}) as {
          arrivalDate: string;
          nights: number;
          adults: number;
        };
        result = await runCheck(arrivalDate, nights, adults);
      }

      return {
        type: "tool_result",
        tool_use_id: block.id ?? "unknown",
        content: JSON.stringify(result),
      };
    })
  );
}
