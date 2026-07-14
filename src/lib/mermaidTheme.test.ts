// Pins the mermaid theming transforms (mermaidTheme.ts): recolorSource's
// directive rewrite (neutral fill, author accent → stroke + text, linkStyle /
// theme-init stripping) and fitSvg's intrinsic-dimension surgery. Both are
// pure string→string, so every branch is directly assertable.

import { describe, expect, test } from "bun:test";
import { fitSvg, recolorSource } from "./mermaidTheme";

const NEUTRAL = "#111";

describe("recolorSource", () => {
  test("classDef: fill becomes neutral, author fill moves to stroke + color", () => {
    expect(recolorSource("classDef hot fill:#f66,stroke-width:2px", NEUTRAL)).toBe(
      "classDef hot fill:#111,stroke:#f66,color:#f66,stroke-width:2px",
    );
  });

  test("style: same rewrite; fill wins as the accent over stroke", () => {
    expect(recolorSource("style A fill:#bbf,stroke:#f66", NEUTRAL)).toBe(
      "style A fill:#111,stroke:#bbf,color:#bbf",
    );
  });

  test("fill:none is not a color — accent falls back to stroke", () => {
    expect(recolorSource("classDef x fill:none,stroke:#0f0", NEUTRAL)).toBe(
      "classDef x fill:#111,stroke:#0f0,color:#0f0",
    );
  });

  test("color-only directive still yields an accent", () => {
    expect(recolorSource("classDef t color:#fa0", NEUTRAL)).toBe(
      "classDef t fill:#111,stroke:#fa0,color:#fa0",
    );
  });

  test("no color at all: neutral fill only, non-color decls preserved", () => {
    expect(recolorSource("classDef q fill:transparent,stroke-width:1px", NEUTRAL)).toBe(
      "classDef q fill:#111,stroke-width:1px",
    );
  });

  test("non-styling lines pass through untouched", () => {
    const src = "graph TD\n  A[Start] --> B{Choice}";
    expect(recolorSource(src, NEUTRAL)).toBe(src);
  });

  test("a node literally named 'style' (no decls) is left alone", () => {
    expect(recolorSource("style foo bar", NEUTRAL)).toBe("style foo bar");
  });

  test("linkStyle lines are dropped so edges stay neutral", () => {
    expect(recolorSource("A --> B\nlinkStyle 0 stroke:#f00\nB --> C", NEUTRAL)).toBe(
      "A --> B\nB --> C",
    );
  });

  test("theme-overriding %%{init}%% is removed; a non-theme init survives", () => {
    expect(recolorSource(`%%{init: {"theme":"dark"}}%%\ngraph TD`, NEUTRAL)).toBe("\ngraph TD");
    const curve = `%%{init: {"flowchart":{"curve":"basis"}}}%%\ngraph TD`;
    expect(recolorSource(curve, NEUTRAL)).toBe(curve);
  });

  test("multi-line theme init blocks are removed too", () => {
    expect(recolorSource(`%%{init: {\n  "theme": "forest"\n}}%%\ngraph TD`, NEUTRAL)).toBe(
      "\ngraph TD",
    );
  });

  test("indentation is preserved (only the trimmed statement is replaced)", () => {
    expect(recolorSource("    classDef a fill:#f00", NEUTRAL)).toBe(
      "    classDef a fill:#111,stroke:#f00,color:#f00",
    );
  });
});

describe("fitSvg", () => {
  const SVG = `<svg id="m" width="100%" style="max-width: 560px;" viewBox="0 0 320 180"><g/></svg>`;

  test("injects intrinsic width/height from the viewBox", () => {
    expect(fitSvg(SVG)).toContain(`<svg width="320" height="180"`);
  });

  test("strips mermaid's width=100% and inline max-width", () => {
    const out = fitSvg(SVG);
    expect(out).not.toContain(`width="100%"`);
    expect(out).not.toContain("max-width");
  });

  test("handles a negative-origin viewBox (size is the 3rd/4th number)", () => {
    expect(fitSvg(`<svg viewBox="-10 -20 300 150"></svg>`)).toContain(
      `<svg width="300" height="150"`,
    );
  });

  test("no viewBox → returned unchanged", () => {
    const plain = `<svg width="100%"><g/></svg>`;
    expect(fitSvg(plain)).toBe(plain);
  });

  test("idempotent: re-running strips and re-adds the same numeric dims", () => {
    const once = fitSvg(SVG);
    expect(fitSvg(once)).toBe(once);
  });

  test("only the root svg tag is rewritten", () => {
    const nested = `<svg viewBox="0 0 10 20"><svg width="5" height="5"/></svg>`;
    expect(fitSvg(nested)).toContain(`<svg width="5" height="5"/>`);
  });
});
