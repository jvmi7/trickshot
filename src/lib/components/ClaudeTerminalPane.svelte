<script lang="ts">
  // The chat surface INSIDE the content card: one worktree's concurrent CLI
  // chats — the focused chat's cell (tabs layout) or a split-tree mosaic of
  // all of them (grid layout). The strip that switches/closes/adds chats
  // lives OUTSIDE the card (ChatTabs.svelte); the MODEL is the chats store +
  // the split tree, and both components render from it. Adding terminals in
  // grid mode is right-click → split up/down/left/right (tmux-style): the
  // new chat takes the chosen half of the clicked cell. Feature component.
  import {
    chatLayout,
    chatSessionsByWorktree,
    chatSplitByWorktree,
    chatStatusByKey,
    DEFAULT_CHAT_ID,
    focusChat,
    focusedChatByWorktree,
    moveChat,
    requestCloseChat,
    selectedWorktree,
    setChatLayout,
    splitChat,
  } from "../stores";
  import { borderGlow } from "../borderGlow";
  import { heal, type SplitWhere, treeToGrid } from "../splitTree";
  import { claudeTermKey, getTerminal } from "../terminal";
  import ClaudeTerminalCell from "./ClaudeTerminalCell.svelte";
  import IconButton from "./IconButton.svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import PanelTop from "@lucide/svelte/icons/panel-top";
  import SquareSplitHorizontal from "@lucide/svelte/icons/square-split-horizontal";
  import SquareSplitVertical from "@lucide/svelte/icons/square-split-vertical";
  import X from "@lucide/svelte/icons/x";

  const wt = $derived($selectedWorktree);
  // ChatTabs seeds the default chat; the fallback below covers the first tick.
  const chats = $derived(wt ? ($chatSessionsByWorktree[wt] ?? []) : []);
  // The focused id, healed against the list (a persisted focus may point at a
  // chat closed in an earlier run).
  const focusedId = $derived.by(() => {
    const f = wt ? $focusedChatByWorktree[wt] : undefined;
    return chats.some((c) => c.id === f) ? (f as string) : (chats[0]?.id ?? DEFAULT_CHAT_ID);
  });
  const grid = $derived($chatLayout === "grid" && chats.length > 1);
  // The mosaic: the persisted split tree healed against the live chat list
  // (dead leaves pruned, appended chats placed), flattened to ONE flat CSS
  // grid — cells stay direct children of .chat-grid so the trail silhouette's
  // observers and union query work unchanged.
  const layout = $derived.by(() => {
    if (!grid) return null;
    const tree = heal(wt ? $chatSplitByWorktree[wt] : undefined, chats.map((c) => c.id));
    return tree ? treeToGrid(tree) : null;
  });

  const SPLITS: { where: SplitWhere; label: string; vertical: boolean }[] = [
    { where: "right", label: "Split right", vertical: false },
    { where: "left", label: "Split left", vertical: false },
    { where: "down", label: "Split down", vertical: true },
    { where: "up", label: "Split up", vertical: true },
  ];

  // Drag-and-drop rearrange, POINTER-based (Tauri's native drag-drop handler
  // swallows HTML5 drag events in WKWebView, so `draggable` never fires):
  // pointerdown on the hover grip captures the pointer — never the cell, so
  // terminal text selection is untouched — pointermove hit-tests the cell +
  // half under the cursor (dashed preview shows exactly where it lands), and
  // release MOVES the dragged chat into that half (the old slot collapses to
  // its sibling — splitTree.moveLeaf, the VS Code editor-group model).
  let dragging = $state<string | null>(null);
  let dropTarget = $state<{ chat: string; zone: SplitWhere } | null>(null);
  let dragLive = $state(false); // past the click slop — feedback engages
  let pressAt: { x: number; y: number } | null = null;
  // The drag GHOST: a miniature pane card riding the cursor (the visual "I'm
  // carrying this window"). Sized from the source cell at grab time — a live
  // xterm clone would be absurdly heavy for a cursor affordance.
  let ghost = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  let ghostText = $state("");
  let grabbedSize: { w: number; h: number } = { w: 120, h: 80 };

  /** One-time read of the grabbed terminal's visible screen (the DOM renderer
   *  has no canvas to snapshot, but the buffer API hands us the text) — the
   *  ghost carries a scaled-down silhouette of the actual content. */
  function screenPreview(chatId: string): string {
    if (!wt) return "";
    try {
      const t = getTerminal(claudeTermKey(wt, chatId)).term;
      const buf = t.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < t.rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines.join("\n").trimEnd();
    } catch {
      return ""; // preview is garnish — never let it break the drag
    }
  }

  function hitTest(e: PointerEvent): { chat: string; zone: SplitWhere } | null {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cellEl = el?.closest<HTMLElement>(".chat-grid-cell");
    const chat = cellEl?.dataset.chat;
    if (!cellEl || !chat || chat === dragging) return null;
    // Nearest edge picks the half (normalized distances → dominant side).
    const r = cellEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edges: [SplitWhere, number][] = [
      ["left", x],
      ["right", 1 - x],
      ["up", y],
      ["down", 1 - y],
    ];
    edges.sort((p, q) => p[1] - q[1]);
    const zone = edges[0]?.[0] ?? "right";
    return { chat, zone };
  }
  function gripDown(e: PointerEvent, chatId: string) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text-selection drag from the grip
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    pressAt = { x: e.clientX, y: e.clientY };
    dragging = chatId; // armed; the dim + previews engage on first real move
    // Ghost dimensions: the grabbed cell at ~1/4 scale, clamped sane.
    const r = grip.closest(".chat-grid-cell")?.getBoundingClientRect();
    if (r) {
      const w = Math.min(200, Math.max(90, r.width * 0.25));
      grabbedSize = { w, h: Math.min(140, Math.max(60, (w * r.height) / r.width)) };
    }
    ghostText = screenPreview(chatId);
  }
  function gripMove(e: PointerEvent) {
    if (!dragging || !pressAt) return;
    // 3px slop so a plain click on the grip never flickers previews.
    if (!dragLive && Math.abs(e.clientX - pressAt.x) + Math.abs(e.clientY - pressAt.y) < 3) return;
    dragLive = true;
    ghost = { x: e.clientX, y: e.clientY, ...grabbedSize };
    dropTarget = hitTest(e);
  }
  function gripUp(e: PointerEvent) {
    if (wt && dragging && dropTarget) {
      moveChat(wt, dragging, dropTarget.chat, dropTarget.zone);
    }
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragging = null;
    dropTarget = null;
    dragLive = false;
    pressAt = null;
    ghost = null;
  }
</script>

{#snippet cellMenu(chatId: string)}
  <ContextMenu.Content>
    {#each SPLITS as s (s.where)}
      <ContextMenu.Item onclick={() => wt && splitChat(wt, chatId, s.where)}>
        {#if s.vertical}
          <SquareSplitVertical class="size-3.5" />
        {:else}
          <SquareSplitHorizontal class="size-3.5" />
        {/if}
        {s.label}
      </ContextMenu.Item>
    {/each}
    {#if chats.length > 1}
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onclick={() => wt && requestCloseChat(wt, chatId)}>
        <X class="size-3.5" />
        Close chat
      </ContextMenu.Item>
      <ContextMenu.Separator />
      {#if grid}
        <ContextMenu.Item onclick={() => setChatLayout("tabs")}>
          <PanelTop class="size-3.5" />
          Tab layout
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item onclick={() => setChatLayout("grid")}>
          <LayoutGrid class="size-3.5" />
          Grid layout
        </ContextMenu.Item>
      {/if}
    {/if}
  </ContextMenu.Content>
{/snippet}

{#if wt}
  {#if grid && layout}
    <div class="chat-grid" style="grid-template-columns: {layout.cols}; grid-template-rows: {layout.rows}">
      {#each layout.cells as cell (cell.chat)}
        <!-- The Trigger's child snippet spreads the contextmenu props onto
             the CELL itself — a wrapper element would break its grid-area. -->
        <!-- focusin (not click): focusing the cell's terminal — however it
             happens — routes injected turns to it. Bubbles from xterm's
             hidden textarea; no interactive-element a11y surface needed. -->
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            {#snippet child({ props })}
              <div
                {...props}
                class="chat-grid-cell"
                style="grid-area: {cell.area}"
                data-chat={cell.chat}
                data-dragging={dragging === cell.chat && dragLive ? "" : undefined}
                data-drop={dropTarget?.chat === cell.chat ? dropTarget.zone : undefined}
                use:borderGlow
                onfocusin={() => focusChat(wt, cell.chat)}
              >
                <ClaudeTerminalCell worktree={wt} chatId={cell.chat} />
                <div class="chat-cell-controls">
                  <span
                    class="chat-drag"
                    role="button"
                    tabindex="-1"
                    aria-label="Drag to rearrange"
                    onpointerdown={(e: PointerEvent) => gripDown(e, cell.chat)}
                    onpointermove={gripMove}
                    onpointerup={gripUp}
                    onpointercancel={gripUp}
                  >
                    <GripVertical class="size-3.5" />
                  </span>
                  <span
                    class="chat-dot"
                    data-status={$chatStatusByKey[claudeTermKey(wt, cell.chat)] ?? "stopped"}
                  ></span>
                  {#if chats.length > 1}
                    <IconButton aria-label="Close chat" onclick={() => wt && requestCloseChat(wt, cell.chat)}>
                      <X />
                    </IconButton>
                  {/if}
                </div>
              </div>
            {/snippet}
          </ContextMenu.Trigger>
          {@render cellMenu(cell.chat)}
        </ContextMenu.Root>
      {/each}
    </div>
    {#if ghost && dragLive}
      <!-- The miniature pane riding the cursor while rearranging: a scaled
           text silhouette of the grabbed terminal's actual screen. pointer-
           events: none, so elementFromPoint hit-testing sees through it. -->
      <div
        class="chat-drag-ghost"
        style="left: {ghost.x}px; top: {ghost.y}px; width: {ghost.w}px; height: {ghost.h}px"
      >
        {#if ghostText}
          <pre class="chat-ghost-screen" aria-hidden="true">{ghostText}</pre>
        {:else}
          <GripVertical class="size-3.5" />
        {/if}
      </div>
    {/if}
  {:else}
    <!-- The same split menu works from tabs layout: splitting jumps to grid
         with both halves showing. -->
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        {#snippet child({ props })}
          <div {...props} class="chat-solo">
            <ClaudeTerminalCell worktree={wt} chatId={focusedId} />
          </div>
        {/snippet}
      </ContextMenu.Trigger>
      {@render cellMenu(focusedId)}
    </ContextMenu.Root>
  {/if}
{/if}
