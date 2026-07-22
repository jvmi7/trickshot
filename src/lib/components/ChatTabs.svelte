<script lang="ts">
  // The chat-session strip — OUTSIDE the terminal card, on the shell band
  // between the header and the content frame (App.svelte mounts it there when
  // the chat surface is showing). Switches chats in tabs layout; acts as the
  // focus/close controls in grid layout. The cells themselves render inside
  // the card (ClaudeTerminalPane). Feature component.
  import {
    addChat,
    chatLayout,
    chatSessionsByWorktree,
    chatStatusByKey,
    closeChat,
    DEFAULT_CHAT_ID,
    ensureDefaultChat,
    focusChat,
    focusedChatByWorktree,
    selectedWorktree,
    setChatLayout,
  } from "../stores";
  import { borderGlow } from "../borderGlow";
  import { slidingTabChrome } from "../slidingHighlight";
  import { claudeTermKey } from "../terminal";
  import IconButton from "./IconButton.svelte";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  const wt = $derived($selectedWorktree);
  // Seed the default chat on render (idempotent) — the strip is the chats
  // list's first reader, so the seeding effect lives here.
  $effect(() => {
    if (wt) ensureDefaultChat(wt);
  });
  const chats = $derived(wt ? ($chatSessionsByWorktree[wt] ?? []) : []);
  // The focused id, healed against the list (a persisted focus may point at a
  // chat closed in an earlier run).
  const focusedId = $derived.by(() => {
    const f = wt ? $focusedChatByWorktree[wt] : undefined;
    return chats.some((c) => c.id === f) ? (f as string) : (chats[0]?.id ?? DEFAULT_CHAT_ID);
  });
  const grid = $derived($chatLayout === "grid" && chats.length > 1);

  // Two-attribute clip protocol for the collapse animation: `data-collapsed`
  // (height/padding/pointer-events) flips instantly with the mode, but
  // `overflow: clip` (`data-clip`) must NOT be unconditional — the sliding
  // chrome deliberately dips 1px below the strip into the card's border row.
  // So the clip lands with the collapse and is released only when the EXPAND
  // finishes (transitionend), restoring the chrome's overlap after the tabs
  // are fully back out of the card.
  let clipping = $state(false);
  $effect(() => {
    if (grid) clipping = true;
  });
  function releaseClip(e: TransitionEvent) {
    // The rail's width slot is the collapse's slowest-settling property (the
    // fade rides the same clock; hover opacities elsewhere would false-fire).
    // Re-check the mode: a mid-flight re-toggle back to grid must keep it.
    if (e.propertyName === "grid-template-columns" && !grid) clipping = false;
  }

  function close(id: string) {
    if (wt) closeChat(wt, id);
  }

  /** Pin each tab to a WHOLE-pixel width. Text-driven widths are fractional
   *  (e.g. 181.95px), which puts every frame joint — arcs, ring notch, side
   *  strokes — on a partial pixel: engines composite the boundary with
   *  partial coverage and the seams read as 1px gaps, differently per
   *  DPI/engine. Integer widths make every abutment exact. (Labels are
   *  static "Chat N", so the pinned width never goes stale.) */
  function snapWidth(el: HTMLElement) {
    const snap = () => {
      const w = el.getBoundingClientRect().width;
      const target = Math.ceil(w);
      if (target - w > 0.01) el.style.width = `${target}px`;
    };
    // Re-measure once fonts settle: a width pinned against fallback metrics
    // would clip the label (the pin also mutes the ResizeObserver).
    const resnap = () => {
      el.style.width = "";
      snap();
    };
    const ro = new ResizeObserver(snap);
    ro.observe(el);
    snap();
    document.fonts?.ready.then(resnap).catch(() => {});
    return { destroy: () => ro.disconnect() };
  }
</script>

{#if wt}
  <!-- Hand-rolled tabs (NOT ui/tabs — a deliberate exception): the connected
       Chrome-style chrome (card-bg fill, top radius, concave flares, border
       overlap) is bespoke app chrome the registry trigger's own utility
       styles can't be overridden into. Styled in app.css › .chat-tab. -->
  <!-- data-first-active drives the flush-left merge (app.css): the card and
       its glow ring square their top-left corner under the first tab. -->
  <!-- data-first-active is OWNED by slidingTabChrome (flush choreography):
       it lands when the chrome's slide arrives at the first tab, not when
       the click happens — the card corner stays rounded during flight. -->
  <!-- data-collapsed fades the TABS out in place in GRID mode (no vertical
       motion) while their width slot closes; the band itself persists,
       keeping the + and layout toggle visible in both layouts, and the
       chrome's data-active tracking survives the fade. -->
  <div
    class="chat-tabs"
    role="tablist"
    aria-label="Chat sessions"
    data-collapsed={grid ? "" : undefined}
    data-clip={clipping ? "" : undefined}
    ontransitionend={releaseClip}
  >
    <!-- The rail: the tabs' width slot. 1fr → 0fr in grid mode so the fading
         tabs also release their LAYOUT width — the + glides to the left edge
         instead of floating after an invisible row. The inner keeps the
         chrome's offset-parent + flex row; its horizontal clip rides
         data-clip (vertical stays visible for the chrome's 1px card dip). -->
    <div class="chat-tabs-rail">
      <div class="chat-tabs-rail-inner">
        <!-- ONE sliding chrome overlay for the active tab (frame stroke, flares,
             glow layers — SIBLING spans: a mask clips its own pseudos):
             slidingTabChrome glides it between tabs; the silhouette bump + ring
             notch animate alongside via clip-path transitions. First in DOM so
             the tab labels paint above it. -->
        <div class="chat-tab-chrome" aria-hidden="true" use:slidingTabChrome use:borderGlow>
          <span class="chat-tab-frame"></span>
          <span class="chat-tab-glow"></span>
          <span class="chat-tab-glow-arc" data-side="left"></span>
          <span class="chat-tab-glow-arc" data-side="right"></span>
        </div>
        {#each chats as c, i (c.id)}
          <button
            type="button"
            role="tab"
            class="chat-tab"
            aria-selected={c.id === focusedId}
            data-active={c.id === focusedId ? "" : undefined}
            onclick={() => focusChat(wt, c.id)}
            use:snapWidth
          >
            <span
              class="chat-dot"
              data-status={$chatStatusByKey[claudeTermKey(wt, c.id)] ?? "stopped"}
            ></span>
            Chat {i + 1}
            {#if chats.length > 1}
              <span
                class="chat-close"
                role="button"
                tabindex="-1"
                aria-label="Close chat"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  close(c.id);
                }}
                onkeydown={(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    close(c.id);
                  }
                }}
              >
                <X class="size-3" />
              </span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <IconButton {...props} aria-label="New chat" onclick={() => wt && addChat(wt)}>
            <Plus />
          </IconButton>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>New chat session in this worktree</Tooltip.Content>
    </Tooltip.Root>
    {#if chats.length > 1}
      <!-- The tabs⇄grid toggle, right-aligned on the strip band (user-placed:
           under the header, not in it). The band PERSISTS in grid mode (only
           the tabs sink), so this toggle is visible in BOTH layouts. -->
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <IconButton
              {...props}
              class={grid ? "ml-auto text-foreground" : "ml-auto"}
              aria-label={grid ? "Tab layout" : "Grid layout"}
              onclick={() => setChatLayout(grid ? "tabs" : "grid")}
            >
              <LayoutGrid />
            </IconButton>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{grid ? "Show one chat (tabs)" : "Show all chats (grid)"}</Tooltip.Content>
      </Tooltip.Root>
    {/if}
  </div>
{/if}
