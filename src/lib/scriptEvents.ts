// The script-event router — the reducer over the `script-event` stream (project
// run/setup/archive scripts), the scripts sibling of agentEvents.ts. Split out of
// App.svelte so it's plain, testable TypeScript. Output lines are coalesced per
// worktree into ONE store write per 16ms window (batching
// engine's batching — a chatty build log must not render per line). setTimeout,
// not requestAnimationFrame, so backgrounded windows still flush.

import { appendScriptLines, endScriptRun, startScriptRun } from "./stores";
import type { ScriptEnvelope } from "./types";

const FLUSH_MS = 16;
const buffers = new Map<string, string[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  for (const [worktree, lines] of buffers) appendScriptLines(worktree, lines);
  buffers.clear();
}

function bufferLine(worktree: string, line: string) {
  const buf = buffers.get(worktree) ?? [];
  buf.push(line);
  buffers.set(worktree, buf);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** Flush any buffered lines NOW (before an exit event, so the tail can't land
 *  after the exited marker; exported for tests). */
export function flushScriptOutput() {
  if (flushTimer) clearTimeout(flushTimer);
  flush();
}

/** Handle one script event (tagged with its worktree) — the single consumer of
 *  the `ScriptEnvelope` kinds. */
export function handleScriptEvent(
  worktree: string,
  kind: ScriptEnvelope["kind"],
  data: string | null,
) {
  switch (kind) {
    case "started":
      // A new run replaces the old buffer too — drop stale unflushed lines.
      buffers.delete(worktree);
      startScriptRun(worktree, data ?? "");
      break;
    case "stdout":
    case "stderr":
      bufferLine(worktree, data ?? "");
      break;
    case "exit": {
      flushScriptOutput();
      const code = data === null ? null : Number(data);
      endScriptRun(worktree, Number.isNaN(code) ? null : code);
      break;
    }
    default: {
      // Exhaustiveness guard (SYNC RULE): a new ScriptEnvelope kind is a compile error.
      const _exhaustive: never = kind;
      void _exhaustive;
    }
  }
}
