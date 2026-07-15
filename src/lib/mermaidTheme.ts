// Pure source/SVG transforms for Mermaid diagram theming, extracted from
// Mermaid.svelte so the branchy logic is unit-testable. Both are string→string
// (no DOM reads): the component resolves live CSS palette values and injects
// them (e.g. `neutralFill`).

/**
 * Rewrite the diagram author's color directives so the BACKGROUND is always
 * neutral while the author's accent moves to the BORDER + TEXT. We do this at
 * the source rather than in CSS because mermaid compiles `classDef`/`style`
 * into id-scoped `#mermaid-… .cls { fill:… !important }` rules — an ID selector
 * a class-based CSS override can't beat — so the only reliable lever is the
 * declarations themselves. `:::cls` references inherit the rewrite; a
 * `linkStyle` is dropped (edges stay neutral) and a theme-overriding
 * `%%{init}%%` block is removed so our neutral base always wins.
 *
 * @param src the raw mermaid source (untrusted assistant content)
 * @param neutralFill the resolved neutral background color (e.g. `--app-panel`)
 */
export function recolorSource(src: string, neutralFill: string): string {
  function isColor(x: string | undefined): boolean {
    return !!x && !/^(none|transparent)$/i.test(x.trim());
  }
  const withoutThemeInit = src.replace(/%%\{[\s\S]*?\}%%/g, (m) => (/theme/i.test(m) ? "" : m));
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

/**
 * Give the svg explicit intrinsic width/height from its viewBox and strip
 * mermaid's `width="100%"` + inline `max-width` (its useMaxWidth behavior).
 * Without this, every diagram is forced to full width, so a tall/narrow one
 * scales up to an absurd height while a wide one collapses short. With numeric
 * intrinsic dims + viewBox, the CSS max-width/max-height "contain" it into one
 * bounded box — tall diagrams cap on height, wide ones on width, both keeping
 * their aspect ratio.
 */
export function fitSvg(svgText: string): string {
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
