<script lang="ts">
  // Owns ALL inline-comment chrome over the chat transcript: detecting a text
  // selection, the floating "add comment" toolbar, (re-)applying the persistent
  // highlights to the rendered messages, and mounting the active thread's popup.
  // Feature component (Tier B). This is the ONE place we touch transcript DOM
  // imperatively — arbitrary-range highlighting over third-party-rendered markdown
  // can't be expressed declaratively — so it's all encapsulated here.
  import { tick } from "svelte";
  import {
    selectedWorktree,
    activeComments,
    activeCommentId,
    renderedGroups,
    scrollCursor,
    addComment,
    openComment,
  } from "../stores";
  import type { CommentThread } from "../comments";
  import CommentPopup from "./CommentPopup.svelte";
  import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";

  // The chat's scroll viewport (passed from Chat); selection + highlighting are
  // scoped to its `[data-msg-key]` message bubbles.
  let { viewport }: { viewport: HTMLElement | null } = $props();

  // Up to how many chars of context to store on either side of a selection, to
  // disambiguate a quote that occurs more than once in the same message.
  const CONTEXT = 32;

  // The pending selection that drives the "add comment" toolbar (null = hidden).
  let sel = $state<
    | null
    | { messageKey: number; quote: string; prefix: string; suffix: string; x: number; y: number }
  >(null);
  // Anchor rect for the open popup (recomputed on scroll / render).
  let popupRect = $state<DOMRect | null>(null);

  const wt = $derived($selectedWorktree);
  const openThread = $derived(
    $activeCommentId ? ($activeComments.find((t) => t.id === $activeCommentId) ?? null) : null,
  );

  function clearSel() {
    sel = null;
  }

  // Walk up to the enclosing `[data-msg-key]` bubble within our viewport (null if
  // the node isn't inside one — e.g. a selection spanning two messages resolves to
  // the messages container, which has no key, so we don't offer a comment).
  function enclosingMessage(node: Node | null): HTMLElement | null {
    let el: HTMLElement | null =
      node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
    while (el) {
      if (el.dataset?.msgKey !== undefined && viewport?.contains(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Accurate prefix/suffix from the live range (text immediately before/after the
  // selection, within the same message) — used to re-find the exact occurrence.
  function rangeContext(msgEl: HTMLElement, range: Range): { prefix: string; suffix: string } {
    const pre = document.createRange();
    pre.selectNodeContents(msgEl);
    pre.setEnd(range.startContainer, range.startOffset);
    const post = document.createRange();
    post.selectNodeContents(msgEl);
    post.setStart(range.endContainer, range.endOffset);
    return {
      prefix: pre.toString().slice(-CONTEXT),
      suffix: post.toString().slice(0, CONTEXT),
    };
  }

  function onSelectionChange() {
    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return clearSel();
    const quote = s.toString();
    if (!quote.trim()) return clearSel();
    const range = s.getRangeAt(0);
    const msgEl = enclosingMessage(range.commonAncestorContainer);
    if (!msgEl) return clearSel();
    const messageKey = Number(msgEl.dataset.msgKey);
    if (!Number.isFinite(messageKey)) return clearSel();
    const { prefix, suffix } = rangeContext(msgEl, range);
    const rect = range.getBoundingClientRect();
    sel = { messageKey, quote, prefix, suffix, x: rect.left + rect.width / 2, y: rect.top };
  }

  function startComment() {
    if (!sel || !wt) return;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}`;
    const thread: CommentThread = {
      id,
      anchor: { messageKey: sel.messageKey, quote: sel.quote, prefix: sel.prefix, suffix: sel.suffix },
      selectedText: sel.quote,
      messages: [],
      pending: false,
      createdAt: Date.now(),
    };
    addComment(wt, thread);
    openComment(id);
    clearSel();
    window.getSelection()?.removeAllRanges();
  }

  // ---- Highlight application (the imperative DOM part) ----
  // Remove any existing comment marks, then wrap each anchored thread's quote in a
  // fresh <mark>. Re-run whenever the rendered messages or the comment set change.
  function unwrapMarks() {
    if (!viewport) return;
    for (const m of viewport.querySelectorAll("mark.comment-highlight")) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
  }

  // Collect a message's text nodes with their start offset in the concatenated text.
  function textNodesOf(root: HTMLElement): { nodes: { node: Text; from: number }[]; full: string } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; from: number }[] = [];
    let full = "";
    let n = walker.nextNode();
    while (n) {
      nodes.push({ node: n as Text, from: full.length });
      full += n.textContent ?? "";
      n = walker.nextNode();
    }
    return { nodes, full };
  }

  // Find the start index of a thread's quote, preferring the occurrence whose
  // surrounding text matches the stored prefix/suffix (disambiguates duplicates).
  function locate(full: string, anchor: CommentThread["anchor"]): number {
    const { quote, prefix, suffix } = anchor;
    if (!quote) return -1;
    let from = 0;
    let fallback = -1;
    for (;;) {
      const at = full.indexOf(quote, from);
      if (at < 0) break;
      if (fallback < 0) fallback = at;
      const before = full.slice(Math.max(0, at - prefix.length), at);
      const after = full.slice(at + quote.length, at + quote.length + suffix.length);
      const okBefore = !prefix || prefix.endsWith(before) || before.endsWith(prefix);
      const okAfter = !suffix || suffix.startsWith(after) || after.startsWith(suffix);
      if (okBefore && okAfter) return at;
      from = at + 1;
    }
    return fallback;
  }

  function wrap(
    nodes: { node: Text; from: number }[],
    start: number,
    end: number,
    id: string,
  ) {
    for (const { node, from } of nodes) {
      const to = from + (node.textContent?.length ?? 0);
      const s = Math.max(start, from);
      const e = Math.min(end, to);
      if (s >= e) continue;
      const range = document.createRange();
      range.setStart(node, s - from);
      range.setEnd(node, e - from);
      const mark = document.createElement("mark");
      mark.className = "comment-highlight";
      mark.dataset.commentId = id;
      // Each sub-range is within ONE text node, so surroundContents can't throw the
      // "partially selected non-Text node" error.
      try {
        range.surroundContents(mark);
      } catch {
        /* skip an un-wrappable fragment; the thread still persists */
      }
    }
  }

  function applyHighlights() {
    if (!viewport) return;
    unwrapMarks();
    for (const t of $activeComments) {
      const msgEl = viewport.querySelector<HTMLElement>(`[data-msg-key="${t.anchor.messageKey}"]`);
      if (!msgEl) continue; // out of the render window — re-anchors when back in view
      const { nodes, full } = textNodesOf(msgEl);
      const start = locate(full, t.anchor);
      if (start < 0) continue;
      wrap(nodes, start, start + t.anchor.quote.length, t.id);
    }
  }

  // Recompute the open popup's anchor rect from its (first) highlight mark.
  function measurePopup() {
    if (!viewport || !$activeCommentId) {
      popupRect = null;
      return;
    }
    const mark = viewport.querySelector<HTMLElement>(
      `mark.comment-highlight[data-comment-id="${$activeCommentId}"]`,
    );
    popupRect = mark ? mark.getBoundingClientRect() : null;
  }

  // Re-apply highlights + re-measure after the transcript or comment set renders.
  $effect(() => {
    void $renderedGroups;
    void $activeComments;
    void tick().then(() => {
      applyHighlights();
      measurePopup();
    });
  });

  // The chat scrolls by CSS transform, so rects move without a native scroll event:
  // re-measure the popup and drop the (now-stale) selection toolbar on scroll.
  $effect(() => {
    void $scrollCursor;
    if (sel) clearSel();
    measurePopup();
  });

  // Open a thread when its highlight is clicked (event delegation on the viewport).
  function onViewportClick(e: MouseEvent) {
    const mark = (e.target as HTMLElement | null)?.closest?.("mark.comment-highlight");
    const id = mark instanceof HTMLElement ? mark.dataset.commentId : undefined;
    if (id) openComment(id);
  }
  $effect(() => {
    const el = viewport;
    if (!el) return;
    el.addEventListener("click", onViewportClick);
    return () => el.removeEventListener("click", onViewportClick);
  });
</script>

<svelte:document onselectionchange={onSelectionChange} />

{#if sel}
  <button
    type="button"
    class="comment-add-btn"
    style="left: {sel.x}px; top: {sel.y}px;"
    title="Comment on selection"
    aria-label="Comment on selection"
    onpointerdown={(e) => e.preventDefault()}
    onclick={startComment}
  >
    <MessageSquarePlus class="size-4" />
  </button>
{/if}

{#if openThread}
  <CommentPopup thread={openThread} rect={popupRect} />
{/if}

<style>
  .comment-add-btn {
    position: fixed;
    z-index: 60;
    transform: translate(-50%, calc(-100% - 8px));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid var(--app-border, var(--border));
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow: 0 4px 14px -4px rgb(0 0 0 / 0.45);
  }
  .comment-add-btn:hover {
    background: var(--app-panel-2, var(--accent));
  }
</style>
