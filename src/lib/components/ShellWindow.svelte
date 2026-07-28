<script lang="ts">
  // The shell as a floating WINDOW (not a popover): a draggable panel that
  // sits ON TOP of the Claude chat underneath — move it wherever it's least
  // in the way, and it stays open while you interact with the chat (a
  // popover would dismiss on outside click). The PTY + xterm still live in
  // the instance cache; this window only re-parents them, so scrollback and
  // the running shell survive open/close/drag. Position persists. Esc is
  // NOT a close key (vim lives in there) — close via the ✕ or the header
  // toggle. Feature component.
  import { setShellOpen, setShellWindowPos, shellWindowPos } from "../stores";
  import IconButton from "./IconButton.svelte";
  import TerminalPane from "./TerminalPane.svelte";
  import X from "@lucide/svelte/icons/x";

  let el = $state<HTMLDivElement | null>(null);

  /** Effective position: the persisted drag point, else the default perch
   *  (top-right, under the header), clamped so the title bar always stays
   *  reachable on the current viewport. */
  const pos = $derived.by(() => {
    const w = el?.offsetWidth ?? 780;
    const raw = $shellWindowPos ?? {
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

  // Title-bar drag (the repo-reorder pointer pattern: window listeners, no
  // capture). Live position rides local state during the drag; the store
  // persists once on release.
  let dragging = $state<{ dx: number; dy: number } | null>(null);
  let live = $state<{ x: number; y: number } | null>(null);
  const shown = $derived(live ?? pos);

  function dragStart(e: PointerEvent) {
    if (e.button !== 0) return;
    const r = el?.getBoundingClientRect();
    if (!r) return;
    dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragEnd);
  }
  function dragMove(e: PointerEvent) {
    const d = dragging;
    if (!d) return;
    live = clampPos({ x: e.clientX - d.dx, y: e.clientY - d.dy }, el?.offsetWidth ?? 780);
  }
  function dragEnd() {
    if (live) setShellWindowPos(live);
    live = null;
    dragging = null;
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragEnd);
  }
  $effect(() => () => dragEnd());
</script>

<div class="shell-window" bind:this={el} style="left: {shown.x}px; top: {shown.y}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="shell-window-bar" data-dragging={dragging ? "" : undefined} onpointerdown={dragStart}>
    <span class="section-label">Shell</span>
    <IconButton aria-label="Close shell" onclick={() => setShellOpen(false)}>
      <X />
    </IconButton>
  </div>
  <TerminalPane />
</div>

<style>
  /* A floating window over the chat: the popover chrome, position-fixed and
     draggable. Sits at chrome level — above the content, below dialogs. */
  .shell-window {
    position: fixed;
    z-index: var(--app-z-chrome);
    display: flex;
    flex-direction: column;
    background: var(--base-surface);
    border: 1px solid var(--app-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--app-shadow-float);
    overflow: hidden;
  }
  .shell-window-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px 4px 12px;
    border-bottom: 1px solid var(--app-border);
    cursor: grab;
    user-select: none;
  }
  .shell-window-bar[data-dragging] {
    cursor: grabbing;
  }
</style>
