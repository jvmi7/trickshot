import { describe, expect, test } from "bun:test";
import {
  isTheme,
  PALETTE_VARS,
  parseCustomThemes,
  THEMES,
  type Theme,
  type ThemePalette,
  themesToCss,
  uniqueThemeId,
} from "./themes";

/** A complete, valid palette for fixtures. */
function palette(overrides: Partial<ThemePalette> = {}): ThemePalette {
  const base = Object.fromEntries(
    (Object.keys(PALETTE_VARS) as (keyof ThemePalette)[]).map((k) => [k, "#123456"]),
  ) as unknown as Record<keyof ThemePalette, string>;
  return { ...base, ...overrides } as ThemePalette;
}

function theme(overrides: Partial<Theme> = {}): Theme {
  return { id: "my-theme", label: "My Theme", palette: palette(), ...overrides };
}

describe("themesToCss", () => {
  test("emits one :root[data-theme] block per theme with every palette var", () => {
    const css = themesToCss([theme({ id: "alpha" }), theme({ id: "beta" })]);
    expect(css).toContain(':root[data-theme="alpha"]');
    expect(css).toContain(':root[data-theme="beta"]');
    for (const cssVar of Object.values(PALETTE_VARS)) {
      // Both blocks carry the var.
      expect(css.split(`${cssVar}:`).length - 1).toBe(2);
    }
  });

  test("defaults to the built-in list", () => {
    const css = themesToCss();
    for (const t of THEMES) expect(css).toContain(`:root[data-theme="${t.id}"]`);
  });
});

describe("isTheme", () => {
  test("accepts a complete custom theme", () => {
    expect(isTheme(theme())).toBe(true);
  });

  test.each([
    ["missing palette key", { ...theme(), palette: { ...palette(), bg: undefined } }],
    ["empty palette value", theme({ palette: palette({ text: "  " }) })],
    ["uppercase id", theme({ id: "MyTheme" })],
    ["id with spaces", theme({ id: "my theme" })],
    ["empty label", theme({ label: " " })],
    ["null", null],
    ["non-object", "term"],
  ])("rejects %s", (_name, value) => {
    expect(isTheme(value)).toBe(false);
  });

  test.each(["{", "}", ";"])("rejects a palette value containing %s (injection guard)", (ch) => {
    expect(isTheme(theme({ palette: palette({ accent: `red${ch}` }) }))).toBe(false);
  });
});

describe("parseCustomThemes", () => {
  test("keeps valid entries, drops invalid ones", () => {
    const raw = JSON.stringify([theme({ id: "keep" }), { id: "broken" }, theme({ id: "keep-2" })]);
    expect(parseCustomThemes(raw).map((t) => t.id)).toEqual(["keep", "keep-2"]);
  });

  test("drops entries colliding with a built-in id or a duplicate", () => {
    const raw = JSON.stringify([
      theme({ id: THEMES[0]?.id ?? "term" }),
      theme({ id: "mine" }),
      theme({ id: "mine" }),
    ]);
    expect(parseCustomThemes(raw).map((t) => t.id)).toEqual(["mine"]);
  });

  test("strips unknown extra fields from the palette", () => {
    const dirty = theme();
    (dirty.palette as unknown as Record<string, string>).sneaky = "value";
    const [parsed] = parseCustomThemes(JSON.stringify([dirty]));
    expect(parsed).toBeDefined();
    expect("sneaky" in (parsed?.palette ?? {})).toBe(false);
  });

  test("non-array JSON yields an empty list", () => {
    expect(parseCustomThemes('{"id":"x"}')).toEqual([]);
  });
});

describe("uniqueThemeId", () => {
  test("slugifies the label", () => {
    expect(uniqueThemeId("My Neon Theme!", [])).toBe("my-neon-theme");
  });

  test("suffixes on collision", () => {
    expect(uniqueThemeId("Ocean", ["ocean"])).toBe("ocean-2");
    expect(uniqueThemeId("Ocean", ["ocean", "ocean-2"])).toBe("ocean-3");
  });

  test("falls back for a label with no usable characters", () => {
    expect(uniqueThemeId("!!!", [])).toBe("theme");
  });
});
