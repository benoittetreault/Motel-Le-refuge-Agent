// Dev-tooling safeguard — runs as the `pretest` lifecycle hook before tests.
//
// This repo is worked on in git worktrees that live INSIDE the main checkout
// (.claude/worktrees/<name>). Both the main checkout and every worktree are
// complete pnpm workspaces exposing the same package name (@workspace/*), so a
// stray `cd` to the wrong root — or `pnpm --filter … test` run from the main
// checkout instead of the worktree — will silently run a DIFFERENT but
// identical-looking copy of the code and pass against stale files.
//
// pnpm/npm run `pretest` automatically before `test`, for BOTH `pnpm run test`
// and `pnpm --filter <pkg> test`, so this banner fires no matter the invocation
// and needs no special incantation. It turns a silent misfire into a visible
// one: you can always see which checkout and which branch the tests ran against.
import { execSync } from "node:child_process";

const cwd = process.cwd();

function safe(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "(unknown)";
  }
}

const branch = safe("git rev-parse --abbrev-ref HEAD");
const head = safe("git rev-parse --short HEAD");
// The worktree's own directory (…/.claude/worktrees/<name>) vs the main
// checkout differ here — this is the line that tells you which tree ran.
const topLevel = safe("git rev-parse --show-toplevel");

const line = "─".repeat(72);
process.stderr.write(
  `${line}\n` +
    `▶ api-server tests\n` +
    `    package dir : ${cwd}\n` +
    `    checkout    : ${topLevel}\n` +
    `    branch/HEAD : ${branch} @ ${head}\n` +
    `${line}\n`
);
