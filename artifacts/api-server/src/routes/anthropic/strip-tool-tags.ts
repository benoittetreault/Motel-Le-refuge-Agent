// Defense-in-depth sanitizer for the COMPLETE (non-streamed) model reply.
//
// A real Anthropic tool call arrives as a structured `tool_use` content block —
// it is NEVER text. So any tool-call / tool-response *syntax that appears as
// TEXT* in the reply is a hallucination the model leaked into guest-facing
// output, and must be removed before the guest sees it.
//
// We deliberately do NOT match specific tag names. Over time the model has
// leaked several different shapes (<tool_call>…</tool_call>,
// <function_calls><invoke>…</invoke></function_calls>, <function_response>…,
// etc.), and it will invent more. Instead we treat as "tool syntax" ANY XML-like
// tag whose name contains one of a few keywords, and strip the whole block —
// including nested inner tags of any name. Being over-eager here is fine: it is
// far better to remove a little legitimate text (vanishingly unlikely in warm,
// prose-only receptionist replies) than to leak a new, unanticipated variant.

// A tag counts as "tool syntax" if its name contains any of these (case-
// insensitive). Covers openers (tool_call, function_calls, invoke, function_call,
// tool_use, action_call, …) and responses (tool_response, function_response,
// tool_result, …).
const TOOL_KEYWORDS = /tool|function|invoke|call|result|response/i;

function isToolLikeName(name: string): boolean {
  return TOOL_KEYWORDS.test(name);
}

// A balanced XML-like block: <name ...attrs>...inner...</name>. Non-greedy inner
// so we stop at the FIRST matching close of that exact name (via the \1
// backreference) — which, for a container like <function_calls>, still swallows
// all of its nested <invoke>/<parameter> children in one go.
const PAIRED_BLOCK = /<([a-zA-Z][\w.:-]*)((?:\s[^>]*)?)>([\s\S]*?)<\/\1\s*>/g;

// The start of any XML-like tag (open or close), used to locate the first
// leftover tool-like tag once all balanced blocks are gone.
const TAG_START = /<\/?([a-zA-Z][\w.:-]*)/g;

export function stripToolTags(text: string): { text: string; stripped: boolean } {
  const original = text;
  let out = text;

  // (1) Remove every balanced tool-like block. We recurse into NON-tool
  //     (innocuous) wrappers so a tool-like block nested inside an otherwise
  //     harmless tag is still removed, and we loop to a fixed point so several
  //     sequential blocks (e.g. a call block followed by a response block) all
  //     go, even if removing one exposes another.
  const stripPairs = (s: string): string =>
    s.replace(PAIRED_BLOCK, (whole, name: string, attrs: string, inner: string) =>
      isToolLikeName(name) ? "" : `<${name}${attrs}>${stripPairs(inner)}</${name}>`
    );
  let previous: string;
  do {
    previous = out;
    out = stripPairs(out);
  } while (out !== previous);

  // (2) Truncation guard. Balanced blocks are gone, so ANY tool-like tag still
  //     present means the reply was cut off mid tool-syntax (an opener with no
  //     matching close, leaving its raw args/JSON dangling). Drop from the first
  //     such tag to the end of the string — this also removes the orphaned inner
  //     content that followed it. Innocuous tags before it are real text and kept.
  //     Over-removing a little trailing text here is deliberate: far safer than
  //     leaking a half-formed tool block to the guest.
  TAG_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_START.exec(out)) !== null) {
    if (isToolLikeName(match[1])) {
      out = out.slice(0, match.index);
      break;
    }
  }
  // (3) Also drop a trailing partial tag with no closing '>' (e.g. '<invoke
  //     name="che') when that fragment looks tool-like. Require a letter right
  //     after '<' so we only touch a real partial tag, never prose like
  //     "price < result".
  out = out.replace(/<[a-zA-Z][^<>]*$/, (fragment) =>
    TOOL_KEYWORDS.test(fragment) ? "" : fragment
  );

  const stripped = out !== original;
  if (stripped) {
    // Tidy whitespace left behind by the removals so the guest never sees odd
    // gaps. Only applied when we actually changed something, so legitimate text
    // is returned byte-for-byte untouched.
    out = out
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return { text: out, stripped };
}
