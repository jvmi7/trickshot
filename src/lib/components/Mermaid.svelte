<script lang="ts">
  // Prop-driven primitive (no stores/api): renders a Mermaid diagram source to
  // an inline SVG. Mermaid runs with `securityLevel: 'strict'` so it sanitizes
  // its own output with DOMPurify and disables click handlers/scripts — safe for
  // untrusted assistant content under the app's `script-src 'self'` CSP. On a
  // syntax error we fall back to the raw fenced source so the diagram text is
  // never lost. Sibling of Markdown.svelte's fenced-code path; theming is read
  // live from the `--app-*`/`--base-*` palette so diagrams follow the active
  // theme (re-rendered when `<html data-theme>` flips, via a MutationObserver).
  import { escapeHtml } from "$lib/highlight";
  import * as Dialog from "$lib/components/ui/dialog";
  import IconButton from "./IconButton.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import Minus from "@lucide/svelte/icons/minus";
  import Maximize from "@lucide/svelte/icons/maximize";
  import Expand from "@lucide/svelte/icons/expand";

  // Lazy-loaded: mermaid is ~MBs, so it's pulled into its own chunk on first
  // diagram render instead of the main bundle (most sessions never show one).
  let mermaidMod: typeof import("mermaid").default | undefined;
  async function getMermaid() {
    if (!mermaidMod) mermaidMod = (await import("mermaid")).default;
    return mermaidMod;
  }

  let { code }: { code: string } = $props();

  let svg = $state("");
  let failed = $state(false);

  // Click-to-expand modal + Excalidraw-style pan/zoom explorer state.
  let expanded = $state(false);
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let dragging = $state(false);
  let viewport = $state<HTMLDivElement>();
  let stage = $state<HTMLDivElement>();
  // Non-reactive drag bookkeeping (no $state — never read in markup).
  let dragId = -1;
  let lastX = 0;
  let lastY = 0;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 8;

  // Unique per instance — mermaid.render needs a DOM-id-safe, collision-free id.
  const id = `mermaid-${Math.random().toString(36).slice(2)}`;

  function v(name: string, fallback: string): string {
    const got = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return got || fallback;
  }

  // Rewrite the diagram author's color directives so the BACKGROUND is always
  // neutral while the author's accent moves to the BORDER + TEXT. We do this at
  // the source rather than in CSS because mermaid compiles `classDef`/`style`
  // into id-scoped `#mermaid-… .cls { fill:… !important }` rules — an ID selector
  // a class-based CSS override can't beat — so the only reliable lever is the
  // declarations themselves. `:::cls` references inherit the rewrite; a
  // `linkStyle` is dropped (edges stay neutral) and a theme-overriding
  // `%%{init}%%` block is removed so our neutral base always wins.
  function recolorSource(src: string): string {
    const neutralFill = v("--app-panel", "#1a1a1a");
    function isColor(x: string | undefined): boolean {
      return !!x && !/^(none|transparent)$/i.test(x.trim());
    }
    const withoutThemeInit = src.replace(/%%\{[\s\S]*?\}%%/g, (m) =>
      /theme/i.test(m) ? "" : m,
    );
    return withoutThemeInit
      .split("\n")
      .filter((line) => !/^\s*linkStyle\b/.test(line))
      .map((line) => {
        const t = line.trim();
        // `classDef <name> …` / `style <node(s)> …` — head + comma-separated decls.
        const m = t.match(/^((?:classDef|style)\s+\S+)\s+(.+)$/);
        const head = m?.[1];
        const body = m?.[2];
        if (!head || !body) return line;
        const decls: Record<string, string> = {};
        for (const d of body.split(",")) {
          const i = d.indexOf(":");
          if (i !== -1) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
        }
        // Not a styling statement (e.g. a node literally named "style") — leave it.
        if (Object.keys(decls).length === 0) return line;
        // Accent = whatever color the author meant (fill first, then stroke/text).
        const accent = [decls.fill, decls.stroke, decls.color].find(isColor);
        const out = [`fill:${neutralFill}`];
        if (accent) out.push(`stroke:${accent}`, `color:${accent}`);
        // Preserve non-color decls (stroke-width, stroke-dasharray, …).
        for (const [k, val] of Object.entries(decls)) {
          if (k !== "fill" && k !== "stroke" && k !== "color") out.push(`${k}:${val}`);
        }
        return line.replace(t, `${head} ${out.join(",")}`);
      })
      .join("\n");
  }

  // Give the svg explicit intrinsic width/height from its viewBox and strip
  // mermaid's `width="100%"` + inline `max-width` (its useMaxWidth behavior).
  // Without this, every diagram is forced to full width, so a tall/narrow one
  // scales up to an absurd height while a wide one collapses short. With numeric
  // intrinsic dims + viewBox, the CSS max-width/max-height "contain" it into one
  // bounded box — tall diagrams cap on height, wide ones on width, both keeping
  // their aspect ratio.
  function fitSvg(svgText: string): string {
    const vb = svgText.match(/viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/);
    const w = vb?.[1];
    const h = vb?.[2];
    if (!w || !h) return svgText;
    return svgText.replace(/<svg\b[^>]*?>/, (tag) => {
      const stripped = tag
        .replace(/\s(?:width|height)="[^"]*"/g, "")
        .replace(/max-width:\s*[^;"]*;?\s*/g, "");
      return stripped.replace(/^<svg/, `<svg width="${w}" height="${h}"`);
    });
  }

  async function render(src: string) {
    if (!src.trim()) {
      svg = "";
      failed = false;
      return;
    }
    try {
      const mermaid = await getMermaid();
      // Resolve the neutral palette once per render so it tracks the live theme.
      const bg = v("--app-bg", "#000");
      const panel = v("--app-panel", "#1a1a1a");
      const panel2 = v("--app-panel-2", "#222");
      const border = v("--app-border", "#333");
      const text = v("--app-text", "#fff");
      const dim = v("--app-dim", "#888");
      // Fully MONOCHROME: mermaid's `base` theme derives node/edge/note/actor
      // colors from these vars, so every color-bearing var is pinned to a neutral
      // grey from the app palette — no hues. Set per diagram type (flowchart,
      // sequence, class, state, …) so nothing colorful leaks through any of them.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          darkMode: true,
          fontFamily: v("--app-font", "inherit"),
          fontSize: "14px",
          background: bg,
          // Primary / secondary / tertiary — all neutral so derivations stay grey.
          primaryColor: panel,
          primaryBorderColor: border,
          primaryTextColor: text,
          secondaryColor: panel2,
          secondaryBorderColor: border,
          secondaryTextColor: text,
          tertiaryColor: panel,
          tertiaryBorderColor: border,
          tertiaryTextColor: text,
          // Edges / lines / labels.
          lineColor: dim,
          textColor: text,
          mainBkg: panel,
          nodeBorder: border,
          nodeTextColor: text,
          edgeLabelBackground: bg,
          titleColor: text,
          // Subgraph clusters.
          clusterBkg: bg,
          clusterBorder: border,
          // Notes.
          noteBkgColor: panel2,
          noteTextColor: text,
          noteBorderColor: border,
          // Sequence diagrams.
          actorBkg: panel,
          actorBorder: border,
          actorTextColor: text,
          actorLineColor: dim,
          signalColor: text,
          signalTextColor: text,
          labelBoxBkgColor: panel,
          labelBoxBorderColor: border,
          labelTextColor: text,
          loopTextColor: text,
          activationBkgColor: panel2,
          activationBorderColor: border,
        },
      });
      const out = await mermaid.render(id, recolorSource(src));
      svg = fitSvg(out.svg);
      failed = false;
    } catch {
      // Invalid diagram → show the source so nothing is lost.
      svg = "";
      failed = true;
    }
  }

  $effect(() => {
    render(code);
  });

  // Re-render on theme/font flip so an existing diagram repaints to the new look.
  $effect(() => {
    const obs = new MutationObserver(() => render(code));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-font"],
    });
    return () => obs.disconnect();
  });

  // --- expand-to-modal pan/zoom ---

  function clampScale(s: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  // Zoom while keeping the viewport point (px,py) fixed under the cursor/pivot.
  function zoomAt(px: number, py: number, factor: number) {
    const next = clampScale(scale * factor);
    const k = next / scale;
    tx = px - k * (px - tx);
    ty = py - k * (py - ty);
    scale = next;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = viewport?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  }

  // Zoom buttons pivot on the viewport center.
  function zoomBy(factor: number) {
    const rect = viewport?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || e.pointerId !== dragId) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== dragId) return;
    dragging = false;
    dragId = -1;
    viewport?.releasePointerCapture?.(e.pointerId);
  }

  // Fit the diagram to the viewport (~92%, contain) and center it. Reads the
  // svg's intrinsic width/height (set by fitSvg) since the stage renders it at
  // natural size and we scale via transform.
  function fit() {
    const vp = viewport;
    const el = stage?.querySelector("svg");
    if (!vp || !el) return;
    const nw = Number.parseFloat(el.getAttribute("width") ?? "0");
    const nh = Number.parseFloat(el.getAttribute("height") ?? "0");
    if (!nw || !nh) {
      scale = 1;
      tx = 0;
      ty = 0;
      return;
    }
    const s = clampScale(Math.min(vp.clientWidth / nw, vp.clientHeight / nh) * 0.92);
    scale = s;
    tx = (vp.clientWidth - nw * s) / 2;
    ty = (vp.clientHeight - nh * s) / 2;
  }

  // Reset the view to a centered fit each time the modal opens.
  $effect(() => {
    if (expanded) requestAnimationFrame(fit);
  });
</script>

{#if failed}
  <pre><code class="hljs">{@html escapeHtml(code)}</code></pre>
{:else if svg}
  <!-- Click to explore: opens the diagram in a near-fullscreen pan/zoom modal.
       mermaid sanitizes this SVG itself (securityLevel: strict). -->
  <button type="button" class="mm-trigger" aria-label="Expand diagram" onclick={() => (expanded = true)}>
    <span class="mm-fit mm-diagram">
      {@html svg}
    </span>
    <span class="mm-hint"><Expand class="size-3.5" /></span>
  </button>

  <Dialog.Root bind:open={expanded}>
    <Dialog.Content class="!block !max-w-[96vw] w-[96vw] h-[92vh] p-0 overflow-hidden">
      <Dialog.Title class="sr-only">Diagram</Dialog.Title>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="mm-viewport"
        class:dragging
        bind:this={viewport}
        onwheel={onWheel}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <div
          class="mm-stage mm-diagram"
          bind:this={stage}
          style="transform: translate({tx}px, {ty}px) scale({scale});"
        >
          {@html svg}
        </div>
        <div class="mm-controls" onpointerdown={(e) => e.stopPropagation()}>
          <IconButton aria-label="Zoom in" onclick={() => zoomBy(1.25)}><Plus class="size-4" /></IconButton>
          <IconButton aria-label="Zoom out" onclick={() => zoomBy(0.8)}><Minus class="size-4" /></IconButton>
          <IconButton aria-label="Reset view" onclick={fit}><Maximize class="size-4" /></IconButton>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}

<style>
  /* ---- in-chat clickable preview ---- */
  /* Full-width clickable band: the hover border/bg spans the whole chat row to
     signal the entire surface is clickable, while the diagram inside stays
     centered and bounded (see .mm-fit) so it doesn't stretch. */
  .mm-trigger {
    position: relative;
    display: block;
    width: 100%;
    margin: 0 0 8px;
    padding: 8px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: none;
    text-align: center;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition:
      border-color 0.12s ease,
      background 0.12s ease;
  }
  .mm-trigger:hover,
  .mm-trigger:focus-visible {
    border-color: var(--app-border);
    background: var(--app-panel);
  }
  /* "Contain" the preview in one bounded box so footprints stay consistent: the
     svg has intrinsic width/height from its viewBox (see fitSvg), and these maxes
     scale it down proportionally — a tall/narrow diagram is bounded by height, a
     wide one by width. */
  .mm-fit {
    position: relative;
    display: inline-flex;
    justify-content: center;
  }
  .mm-fit :global(svg) {
    width: auto;
    height: auto;
    max-width: min(100%, 560px);
    max-height: 420px;
  }
  /* "Click to expand" affordance, revealed on hover. */
  .mm-hint {
    position: absolute;
    top: 6px;
    right: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: var(--app-panel-2);
    border: 1px solid var(--app-border);
    color: var(--app-dim);
    opacity: 0;
    transition: opacity 0.12s ease;
    pointer-events: none;
  }
  .mm-trigger:hover .mm-hint,
  .mm-trigger:focus-visible .mm-hint {
    opacity: 1;
  }

  /* ---- expanded pan/zoom modal ---- */
  .mm-viewport {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--app-bg);
    border-radius: inherit;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .mm-viewport.dragging {
    cursor: grabbing;
  }
  .mm-stage {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    will-change: transform;
  }
  /* Render the svg at natural size in the modal; the stage transform does the
     scaling (so pan/zoom is crisp), unlike the bounded in-chat preview. */
  .mm-stage :global(svg) {
    display: block;
    max-width: none;
    max-height: none;
  }
  .mm-controls {
    position: absolute;
    right: 12px;
    bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    background: var(--app-panel);
    border: 1px solid var(--app-border);
    border-radius: 10px;
  }

  /* ---- neutral palette, shared by the preview AND the modal (.mm-diagram) ----
     Default for un-styled nodes; an author's `classDef`/`style` accent is
     redirected (see recolorSource) to stroke + text and emitted as an id-scoped
     rule that outranks these, so author borders/text win while the fill keeps
     every background neutral. */
  .mm-diagram :global(.node rect),
  .mm-diagram :global(.node circle),
  .mm-diagram :global(.node ellipse),
  .mm-diagram :global(.node polygon),
  .mm-diagram :global(.node path),
  .mm-diagram :global(.label-container) {
    fill: var(--app-panel) !important;
    stroke: var(--app-border);
  }
  .mm-diagram :global(.cluster rect) {
    fill: var(--app-bg) !important;
    stroke: var(--app-border) !important;
  }
  /* Edges / arrowheads. */
  .mm-diagram :global(.edgePath .path),
  .mm-diagram :global(.flowchart-link),
  .mm-diagram :global(.messageLine0),
  .mm-diagram :global(.messageLine1) {
    stroke: var(--app-dim) !important;
  }
  .mm-diagram :global(.arrowheadPath),
  .mm-diagram :global(marker path),
  .mm-diagram :global(.marker) {
    fill: var(--app-dim) !important;
    stroke: var(--app-dim) !important;
  }
  /* No text-color override: default text comes from `themeVariables` (neutral),
     and an author accent reaches node text via its id-scoped `color:` rule. */
  /* Edge-label backplates sit on the diagram background. */
  .mm-diagram :global(.edgeLabel) {
    background-color: var(--app-bg) !important;
  }
  .mm-diagram :global(.edgeLabel rect),
  .mm-diagram :global(.labelBkg) {
    fill: var(--app-bg) !important;
  }
</style>
