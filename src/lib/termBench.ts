// Dev-only terminal throughput bench — the "measure before tuning" harness
// (CLAUDE.md › PERFORMANCE) for renderer/transport changes. Drives synthetic
// PTY-shaped workloads straight through xterm's write path, so it measures the
// webview cost (parse + render) in ISOLATION from the Rust relay: run it
// before/after a renderer or transport change and compare MB/s + fps.
//
// Loaded only in dev (terminal.ts gates the dynamic import behind
// `import.meta.env.DEV`). Usage, from the devtools console:
//
//   await __termBench()                      // all workloads, attached terminal
//   await __termBench({ workload: "paint" }) // one workload
//   await __termBench({ mb: 16 })            // more data per workload
//   await __termBench({ key: "/path/to/worktree" }) // a specific cached xterm
//
// The bench paints INTO the visible terminal (write() is local — nothing
// reaches the PTY or the process behind it); it resets the screen when done,
// and a live TUI repaints itself on its next output anyway.

import type { Terminal } from "@xterm/xterm";

export type BenchWorkload = "scroll" | "sgr" | "paint";

export interface BenchResult {
  workload: BenchWorkload;
  bytes: number;
  ms: number;
  mbPerSec: number;
  frames: number;
  fps: number;
}

/** Mimic the Rust reader's event granularity so xterm's write buffer sees
 *  realistic chunk sizes (terminal.rs reads 64KiB). */
const CHUNK_BYTES = 65536;

/** Plain ASCII scroll — the `cat bigfile.log` shape. */
function scrollLine(cols: number, i: number): string {
  const body = `${i.toString().padStart(8, "0")} lorem ipsum dolor sit amet consectetur `;
  return `${body.repeat(Math.ceil(cols / body.length)).slice(0, cols - 1)}\r\n`;
}

/** SGR-heavy scroll — truecolor + attribute churn per word (chatty build logs,
 *  diff/lint output). */
function sgrLine(cols: number, i: number): string {
  let line = "";
  let w = 0;
  while (line.length < cols * 3 && w < cols / 8) {
    const c = (i * 31 + w * 47) % 256;
    line += `\x1b[38;2;${c};${255 - c};${(c * 7) % 256}m\x1b[${w % 2 ? 1 : 22}mword${w} `;
    w++;
  }
  return `${line}\x1b[0m\r\n`;
}

/** Full-screen repaint — the TUI shape: cursor home, then every row redrawn
 *  in color (what a busy Claude Code frame does at full rate). */
function paintFrame(cols: number, rows: number, i: number): string {
  let frame = "\x1b[H";
  for (let r = 0; r < rows; r++) {
    const c = (i * 13 + r * 29) % 256;
    frame += `\x1b[38;2;${c};${(c * 3) % 256};${255 - c}m`;
    frame += "█▓▒░ ".repeat(Math.ceil(cols / 5)).slice(0, cols - 1);
    if (r < rows - 1) frame += "\r\n";
  }
  return `${frame}\x1b[0m`;
}

/** Build ~`mb` MB of workload data, pre-split into PTY-sized chunks. */
function buildChunks(workload: BenchWorkload, term: Terminal, mb: number): string[] {
  const target = mb * 1024 * 1024;
  const chunks: string[] = [];
  let chunk = "";
  let total = 0;
  let i = 0;
  while (total < target) {
    const piece =
      workload === "scroll"
        ? scrollLine(term.cols, i)
        : workload === "sgr"
          ? sgrLine(term.cols, i)
          : paintFrame(term.cols, term.rows, i);
    i++;
    chunk += piece;
    if (chunk.length >= CHUNK_BYTES) {
      chunks.push(chunk);
      total += chunk.length;
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Write every chunk and resolve once xterm has PARSED the last one (the
 *  write callback), counting rAF frames along the way for effective fps. */
function runWorkload(term: Terminal, workload: BenchWorkload, mb: number): Promise<BenchResult> {
  return new Promise((resolve) => {
    const chunks = buildChunks(workload, term, mb);
    const bytes = chunks.reduce((n, c) => n + c.length, 0);
    let frames = 0;
    let counting = true;
    const tick = () => {
      if (!counting) return;
      frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const start = performance.now();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      if (i < chunks.length - 1) {
        term.write(chunk);
      } else {
        term.write(chunk, () => {
          const ms = performance.now() - start;
          counting = false;
          term.write("\x1b[0m\x1b[2J\x1b[H"); // leave the screen clean
          resolve({
            workload,
            bytes,
            ms: Math.round(ms),
            mbPerSec: Math.round((bytes / 1024 / 1024 / (ms / 1000)) * 10) / 10,
            frames,
            fps: Math.round(frames / (ms / 1000)),
          });
        });
      }
    }
  });
}

/** Register `__termBench` on the console, over the live instance cache. */
export function installTermBench(instances: Map<string, { term: Terminal }>) {
  const bench = async (opts?: { workload?: BenchWorkload; mb?: number; key?: string }) => {
    const mb = opts?.mb ?? 4;
    const inst = opts?.key
      ? instances.get(opts.key)
      : [...instances.values()].find((i) => i.term.element?.isConnected);
    if (!inst) {
      console.warn("[termBench] no attached terminal — open a worktree first (or pass { key })");
      return [];
    }
    const workloads: BenchWorkload[] = opts?.workload
      ? [opts.workload]
      : ["scroll", "sgr", "paint"];
    const results: BenchResult[] = [];
    for (const w of workloads) results.push(await runWorkload(inst.term, w, mb));
    console.table(results);
    return results;
  };
  // Cast confined here: globalThis has no typed slot for the dev-only hook.
  (globalThis as any).__termBench = bench;
  console.info("[termBench] ready — run __termBench() in this console");
}
