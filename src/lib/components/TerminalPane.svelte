<script lang="ts">
  // The Terminal view: attaches the selected worktree's persistent xterm
  // instance (see lib/terminal.ts — scrollback survives tab switches) to this
  // pane, keeps it sized via the fit addon, and (re)opens the PTY on mount.
  // Feature component, sibling of GitPanel/RunOutput in the mainView switch.
  import { selectedWorktree } from "../stores";
  import { ensureOpen, getTerminal, themeColors } from "../terminal";
  import * as api from "../api";

  let container = $state<HTMLDivElement | null>(null);
  let error = $state("");

  // (Re)attach when the worktree or container changes.
  $effect(() => {
    const wt = $selectedWorktree;
    const el = container;
    if (!wt || !el) return;

    const inst = getTerminal(wt);
    // Re-parent the persistent terminal. xterm's open() is once-per-instance:
    // after the first open, MOVE its element (the supported re-attach path)
    // instead of calling open() again.
    el.replaceChildren(); // drop a previous worktree's terminal DOM
    if (inst.term.element) el.appendChild(inst.term.element);
    else inst.term.open(el);
    // Re-sync the theme snapshot to the LIVE CSS vars so xterm's background is
    // pixel-identical to the pane behind it (also picks up theme switches).
    inst.term.options.theme = themeColors();
    inst.term.focus();
    error = "";

    // Fit AFTER layout settles, coalesced to one rAF per burst. Fitting
    // synchronously inside the ResizeObserver callback mutates layout and
    // re-triggers the observer ("ResizeObserver loop completed with
    // undelivered notifications"), which can thrash xterm down to a tiny
    // rows/cols render (a black pane). Only a REAL dimension change is
    // pushed to the PTY.
    let raf = 0;
    let disposed = false;
    const fitNow = () => {
      raf = 0;
      if (disposed || !el.clientHeight) return;
      // Basic garbage guard (renderer not measured at all yet).
      const dims = inst.fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 4 || dims.rows < 2) {
        return;
      }
      const before = { rows: inst.term.rows, cols: inst.term.cols };
      inst.fit.fit();
      // The DOM renderer rounds each row to device pixels, so the PAINTED grid
      // can end up a few px taller than fit's fractional math — clipping the
      // bottom row (where TUI status bars live). If the painted screen
      // overflows the host, give a row back.
      const screen = el.querySelector(".xterm-screen");
      if (
        screen &&
        screen.getBoundingClientRect().height > el.clientHeight &&
        inst.term.rows > 2
      ) {
        inst.term.resize(inst.term.cols, inst.term.rows - 1);
      }
      const { rows, cols } = inst.term;
      if (rows !== before.rows || cols !== before.cols) {
        api.termResize(wt, rows, cols).catch(() => {});
      }
    };
    const scheduleFit = () => {
      if (!raf) raf = requestAnimationFrame(fitNow);
    };
    // SETTLE LOOP: xterm's cell metrics are wrong until the renderer measures
    // the real font — a fit in that window computes a badly narrow grid (a
    // full-width pane at ~20 cols), and NOTHING re-fires later because the
    // pane's own size never changes. So for the first ~3s after (re)attach,
    // keep re-proposing; fitNow only pushes actual changes, so once metrics
    // settle the grid snaps to the true size and further polls are no-ops.
    (async () => {
      for (let i = 0; i < 15 && !disposed; i++) {
        scheduleFit();
        await new Promise((r) => setTimeout(r, 200));
      }
    })();

    ensureOpen(wt)
      .then(() => {
        scheduleFit();
        inst.term.focus();
      })
      .catch((e) => {
        error = String(e);
      });

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);
    scheduleFit();
    return () => {
      disposed = true;
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<div class="term-pane">
  {#if error}
    <div class="term-error error-text">{error}</div>
  {/if}
  <div class="term-host" bind:this={container}></div>
</div>

<style>
  .term-pane {
    /* .content is a flex ROW — claim the full pane (Chat/GitPanel do the same);
       without flex:1 this shrinks to fit its content. The spacing lives HERE,
       not on .term-host: the fit addon measures the host's computed height,
       which under border-box includes its own padding — padding on the host
       over-counts the rows and the bottom rows draw off-pane. */
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 8px 0 8px 12px;
    background: var(--base-bg);
  }
  .term-host {
    flex: 1;
    min-height: 0;
    overflow: hidden; /* nothing escapes even mid-refit */
    /* The grid (rows × cell height) never exactly fills the host — the
       leftover strip below the last row must be OUR background, not an
       xterm-internal surface. Deliberately NO height:100% on .xterm: letting
       it size to its grid keeps xterm's own layers out of the leftover. */
    background: var(--base-bg);
  }
  /* Text styling is the shared .error-text (app.css); this just pads it off the
     pane edges. */
  .term-error {
    padding: 6px 12px;
  }
</style>
