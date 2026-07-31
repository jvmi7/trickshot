<script lang="ts">
  // The run output as a floating WIDGET (ShellWindow's sibling): a draggable
  // frosted panel perched top-right over the chat — the script log without
  // giving up the Claude pane. The run itself streams into the store either
  // way; this window only shows/hides it. Close via the ✕ or the header Run
  // tab toggle. Feature component.
  import { activeScriptRun, runWindowPos, setRunOpen, setRunWindowPos } from "../stores";
  import IconButton from "./IconButton.svelte";
  import RunOutput from "./RunOutput.svelte";
  import X from "@lucide/svelte/icons/x";

  let el = $state<HTMLDivElement | null>(null);

  /** Effective position: the persisted drag point, else the default perch
   *  (top-right, under the header), clamped so the title bar always stays
   *  reachable on the current viewport. */
  const pos = $derived.by(() => {
    const w = el?.offsetWidth ?? 560;
    const raw = $runWindowPos ?? {
      x: (typeof window !== "undefined" ? window.innerWidth : 1200) - w - 24,
      y: 44,
    };
    return clampPos(raw, w);
  });

  function clampPos(p: { x: number; y: number }, w: number) {
    if (typeof window === "undefined") return p;
    return {
      x: Math.max(8, Math.min(p.x, window.innerWidth - Math.min(w, 200))),
      y: Math.max(38, Math.min(p.y, window.innerHeight - 60)),
    };
  }

  // Title-bar drag — the ShellWindow pointer pattern: window listeners, live
  // position on local state, the store persists once on release.
  let dragging = $state<{ dx: number; dy: number } | null>(null);
  let live = $state<{ x: number; y: number } | null>(null);
  const shown = $derived(live ?? pos);

  function dragStart(e: PointerEvent) {
    if (e.button !== 0) return;
    const r = el?.getBoundingClientRect();
    if (!r) return;
    e.preventDefault();
    dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragEnd);
  }
  function dragMove(e: PointerEvent) {
    const d = dragging;
    if (!d) return;
    live = clampPos({ x: e.clientX - d.dx, y: e.clientY - d.dy }, el?.offsetWidth ?? 560);
  }
  function dragEnd() {
    if (live) setRunWindowPos(live);
    live = null;
    dragging = null;
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragEnd);
  }
  $effect(() => () => dragEnd());
</script>

<div class="run-window" bind:this={el} style="left: {shown.x}px; top: {shown.y}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="run-window-bar" data-dragging={dragging ? "" : undefined} onpointerdown={dragStart}>
    <span class="section-label">Run{$activeScriptRun ? ` — ${$activeScriptRun.name}` : ""}</span>
    <IconButton aria-label="Close run output" onclick={() => setRunOpen(false)}>
      <X />
    </IconButton>
  </div>
  <div class="run-window-body">
    <RunOutput />
  </div>
</div>

<style>
  /* ShellWindow's sibling: same frosted-glass floating chrome, sized by the
     window with floors/guards (the .term-pane-popover sizing precedent). */
  .run-window {
    position: fixed;
    z-index: var(--app-z-chrome);
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, black 20%, transparent);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    border: 1px solid var(--app-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--app-shadow-float);
    overflow: hidden;
    transition: background var(--app-duration-slow) var(--ease-out-soft);
  }
  /* Pointer inside = reading the log: firm the glass up like the focused
     shell so the text holds over busy chat output. */
  .run-window:hover {
    background: color-mix(in srgb, black 50%, transparent);
  }
  .run-window-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px 4px 12px;
    cursor: grab;
    user-select: none;
  }
  .run-window-bar[data-dragging] {
    cursor: grabbing;
  }
  .run-window-body {
    display: flex;
    min-height: 0;
    width: clamp(360px, 36vw, 90vw);
    height: clamp(220px, 38vh, 85vh);
  }
</style>
