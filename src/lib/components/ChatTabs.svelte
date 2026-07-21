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
    DEFAULT_CHAT_ID,
    ensureDefaultChat,
    focusChat,
    focusedChatByWorktree,
    removeChat,
    selectedWorktree,
    setChatLayout,
  } from "../stores";
  import { borderGlow } from "../borderGlow";
  import { slidingTabChrome } from "../slidingHighlight";
  import { claudeTermKey, disposeChatTerminal } from "../terminal";
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

  function close(id: string) {
    if (!wt) return;
    disposeChatTerminal(wt, id); // PTY + xterm; the transcript on disk stays
    removeChat(wt, id);
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
  <div
    class="chat-tabs"
    role="tablist"
    aria-label="Chat sessions"
    data-first-active={chats[0]?.id === focusedId ? "" : undefined}
  >
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
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <IconButton
              {...props}
              aria-label={grid ? "Tab layout" : "Grid layout"}
              class={grid ? "text-foreground" : ""}
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
