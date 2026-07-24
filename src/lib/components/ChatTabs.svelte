<script lang="ts">
  // The chat-session strip — OUTSIDE the terminal card, on the shell band
  // between the header and the content frame (App.svelte mounts it there when
  // the chat surface is showing). Switches chats in tabs layout; acts as the
  // focus/close controls in grid layout. The cells themselves render inside
  // the card (ClaudeTerminalPane). Feature component.
  import {
    addChat,
    chatCloseRequest,
    chatLayout,
    chatSessionsByWorktree,
    chatStatusByKey,
    clearChatCloseRequest,
    closeChat,
    DEFAULT_CHAT_ID,
    ensureDefaultChat,
    focusChat,
    focusedChatByWorktree,
    requestCloseChat,
    selectedWorktree,
    setChatLayout,
  } from "../stores";
  import { borderGlow } from "../borderGlow";
  import { slidingTabChrome, slidingToggle } from "../slidingHighlight";
  import { claudeTermKey } from "../terminal";
  import { profileAccent } from "../termProfiles";
  import IconButton from "./IconButton.svelte";
  import IdentityGlyph from "./IdentityGlyph.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import PanelTop from "@lucide/svelte/icons/panel-top";
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
    if (wt) requestCloseChat(wt, id); // the confirm dialog below does the deed
  }
  // The confirmed close (the dialog's OK): dispose + drop, then dismiss.
  function confirmClose() {
    const req = $chatCloseRequest;
    if (req) closeChat(req.worktree, req.chatId);
    clearChatCloseRequest();
  }
  // "Chat N" for the dialog copy — the pending chat's position in the list.
  const closingLabel = $derived.by(() => {
    const req = $chatCloseRequest;
    if (!req) return "";
    const i = chats.findIndex((c) => c.id === req.chatId);
    return i >= 0 ? `Chat ${i + 1}` : "this chat";
  });

  /** Chrome-style tab widths: every tab takes TAB_MAX until the band can't
   *  fit them all, then they shrink EQUALLY (floored at TAB_MIN). Computed in
   *  JS, not flex: the chrome's 1px frame joints — arcs, ring notch, side
   *  strokes — must land on WHOLE pixels (fractional widths composite with
   *  partial coverage and read as 1px gaps, differently per DPI/engine), and
   *  flex hands out fractional shares. */
  const TAB_MAX = 180;
  const TAB_MIN = 72;
  const TAB_GAP = 2; // mirrors the strip's flex gap
  // The +'s breathing room off the last tab — applied INLINE on the button
  // (not a CSS rule) so the width math and the layout share one constant.
  const PLUS_GAP = 6;
  let stripEl = $state<HTMLElement | null>(null);
  let railEl = $state<HTMLElement | null>(null);
  let tabWidth = $state(TAB_MAX);
  function sizeTabs() {
    const strip = stripEl;
    const rail = railEl;
    if (!strip || !rail || grid) return; // never re-size mid-collapse
    const cs = getComputedStyle(strip);
    let avail =
      strip.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
    // Everything on the band that ISN'T the tabs' slot (+, layout toggle)
    // keeps its measured width; the tabs share what remains. NEVER read
    // computed margins here: getComputedStyle returns the USED value of the
    // toggle's `margin-left: auto` (hundreds of px of right-anchoring slack),
    // which would swallow the whole band and crush the tabs to TAB_MIN.
    for (const child of strip.children) {
      if (child !== rail) avail -= (child as HTMLElement).offsetWidth + TAB_GAP;
    }
    avail -= PLUS_GAP; // the +'s inline margin (the one real margin on the band)
    const n = chats.length;
    if (n < 1) return;
    avail -= TAB_GAP * (n - 1);
    tabWidth = Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor(avail / n)));
  }
  $effect(() => {
    const strip = stripEl;
    if (!strip) return;
    const ro = new ResizeObserver(sizeTabs);
    ro.observe(strip);
    return () => ro.disconnect();
  });
  $effect(() => {
    void chats.length;
    if (!grid) requestAnimationFrame(sizeTabs); // post-layout: the toggle mounts with chat #2
  });
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
    bind:this={stripEl}
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
    <div class="chat-tabs-rail" bind:this={railEl}>
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
          {@const status = $chatStatusByKey[claudeTermKey(wt, c.id)] ?? "stopped"}
          <button
            type="button"
            role="tab"
            class="chat-tab"
            style="width: {tabWidth}px"
            aria-selected={c.id === focusedId}
            data-active={c.id === focusedId ? "" : undefined}
            onclick={() => focusChat(wt, c.id)}
          >
            {#if status === "busy"}
              <!-- A running terminal shows the SWATCH (the workspace's 3×3
                   identity mark) in its loading morph — the same busy signal
                   as the sidebar row. Idle/stopped keep the quiet dot. -->
              <IdentityGlyph seed={wt} color={profileAccent(wt)} size={10} loading={true} />
            {:else}
              <span class="chat-dot" data-status={status}></span>
            {/if}
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
          <IconButton
            {...props}
            class="chat-add-btn"
            style="margin-left: {PLUS_GAP}px"
            aria-label="New chat"
            onclick={() => wt && addChat(wt)}
          >
            <Plus />
          </IconButton>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>New chat session in this worktree</Tooltip.Content>
    </Tooltip.Root>
    {#if chats.length > 1}
      <!-- The tabs⇄grid control, right-aligned on the strip band (user-placed:
           under the header, not in it) and visible in BOTH layouts (the band
           persists). A two-segment SLIDER: the active pill glides between the
           tab icon and the grid icon (slidingToggle, the ViewToggle sibling). -->
      <div
        class="chat-layout-toggle ml-auto"
        role="group"
        aria-label="Chat layout"
        use:slidingToggle={{ radius: "var(--app-tab-radius)" }}
      >
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <IconButton
                {...props}
                data-active={grid ? undefined : ""}
                aria-label="Tab layout"
                onclick={() => setChatLayout("tabs")}
              >
                <PanelTop />
              </IconButton>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Show one chat (tabs)</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <IconButton
                {...props}
                data-active={grid ? "" : undefined}
                aria-label="Grid layout"
                onclick={() => setChatLayout("grid")}
              >
                <LayoutGrid />
              </IconButton>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Show all chats (grid)</Tooltip.Content>
        </Tooltip.Root>
      </div>
    {/if}
  </div>

  <!-- Close-chat confirmation (the Worktrees confirm-Dialog pattern): every
       close path — tab ✕, grid cell ✕, cell context menu — routes through
       requestCloseChat and lands here before anything is disposed. -->
  <Dialog.Root open={!!$chatCloseRequest} onOpenChange={(open) => !open && clearChatCloseRequest()}>
    <Dialog.Content>
      <Dialog.Header>
        <Dialog.Title>Close {closingLabel}?</Dialog.Title>
        <Dialog.Description>
          This ends the chat's CLI session. The conversation stays in Claude Code's history — a
          future chat can resume it.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="secondary" onclick={clearChatCloseRequest}>Cancel</Button>
        <Button variant="destructive" onclick={confirmClose}>Close chat</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
