import { describe, expect, test } from "bun:test";
import { hasAnsi, parseAnsi } from "./ansi";

describe("parseAnsi — plain passthrough", () => {
  test("plain text is a single classless span", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world", classes: "" }]);
  });

  test("empty input yields no spans", () => {
    expect(parseAnsi("")).toEqual([]);
  });
});

describe("parseAnsi — SGR attributes", () => {
  test("fg + bold accumulate, then a bg joins, then reset clears", () => {
    expect(parseAnsi("\x1b[1;31mred\x1b[44mblue\x1b[0mplain")).toEqual([
      { text: "red", classes: "ansi-fg-1 ansi-bold" },
      { text: "blue", classes: "ansi-fg-1 ansi-bg-4 ansi-bold" },
      { text: "plain", classes: "" },
    ]);
  });

  test("un-set codes 22/23/24 peel attributes off individually", () => {
    expect(parseAnsi("\x1b[1;2;3;4mall\x1b[22ma\x1b[23mb\x1b[24mc")).toEqual([
      { text: "all", classes: "ansi-bold ansi-dim ansi-italic ansi-underline" },
      { text: "a", classes: "ansi-italic ansi-underline" },
      { text: "b", classes: "ansi-underline" },
      { text: "c", classes: "" },
    ]);
  });

  test("39/49 reset fg/bg independently", () => {
    expect(parseAnsi("\x1b[31;42mx\x1b[39my\x1b[49mz")).toEqual([
      { text: "x", classes: "ansi-fg-1 ansi-bg-2" },
      { text: "y", classes: "ansi-bg-2" },
      { text: "z", classes: "" },
    ]);
  });

  test("90-97 / 100-107 map to the bright slots 8-15", () => {
    expect(parseAnsi("\x1b[90ma\x1b[97mb")).toEqual([
      { text: "a", classes: "ansi-fg-8" },
      { text: "b", classes: "ansi-fg-15" },
    ]);
    expect(parseAnsi("\x1b[100ma\x1b[107mb")).toEqual([
      { text: "a", classes: "ansi-bg-8" },
      { text: "b", classes: "ansi-bg-15" },
    ]);
  });

  test("same-style escapes do not split the span", () => {
    expect(parseAnsi("\x1b[31ma\x1b[31mb")).toEqual([{ text: "ab", classes: "ansi-fg-1" }]);
  });
});

describe("parseAnsi — 256-color mapping", () => {
  const fg = (n: number, text = "x") => parseAnsi(`\x1b[38;5;${n}m${text}`)[0]?.classes;

  test("0-15 pass through directly", () => {
    expect(fg(5)).toBe("ansi-fg-5");
    expect(fg(12)).toBe("ansi-fg-12");
  });

  test("color cube maps by dominant hue, bright when the max level is high", () => {
    expect(fg(196)).toBe("ansi-fg-9"); // pure bright red (5,0,0)
    expect(fg(21)).toBe("ansi-fg-12"); // pure bright blue (0,0,5)
    expect(fg(28)).toBe("ansi-fg-2"); // dark green (0,2,0) — not bright
    expect(fg(51)).toBe("ansi-fg-14"); // cyan (0,5,5)
    expect(fg(226)).toBe("ansi-fg-11"); // yellow (5,5,0)
  });

  test("the cube's gray diagonal maps by lightness band", () => {
    expect(fg(59)).toBe("ansi-fg-0"); // (1,1,1)
    expect(fg(102)).toBe("ansi-fg-8"); // (2,2,2)
    expect(fg(188)).toBe("ansi-fg-7"); // (4,4,4)
    expect(fg(231)).toBe("ansi-fg-15"); // (5,5,5)
  });

  test("grayscale ramp 232-255 maps to 0/8/7/15 by band", () => {
    expect(fg(232)).toBe("ansi-fg-0");
    expect(fg(240)).toBe("ansi-fg-8");
    expect(fg(250)).toBe("ansi-fg-7");
    expect(fg(255)).toBe("ansi-fg-15");
  });

  test("48;5;n styles the background", () => {
    expect(parseAnsi("\x1b[48;5;196mx")).toEqual([{ text: "x", classes: "ansi-bg-9" }]);
  });
});

describe("parseAnsi — 24-bit color", () => {
  test("38;2;r;g;b is consumed but unstyled (falls back to default)", () => {
    expect(parseAnsi("\x1b[31mA\x1b[38;2;10;20;30mB")).toEqual([
      { text: "A", classes: "ansi-fg-1" },
      { text: "B", classes: "" },
    ]);
  });

  test("48;2;r;g;b is consumed but unstyled", () => {
    expect(parseAnsi("\x1b[41mA\x1b[48;2;0;0;0mB")).toEqual([
      { text: "A", classes: "ansi-bg-1" },
      { text: "B", classes: "" },
    ]);
  });
});

describe("parseAnsi — stripping non-SGR sequences", () => {
  test("cursor movement / erase CSI sequences are stripped without splitting", () => {
    expect(parseAnsi("\x1b[2Ka\x1b[3;4Hb\x1b[?25lc")).toEqual([{ text: "abc", classes: "" }]);
  });

  test("OSC sequences (BEL- and ST-terminated) are stripped", () => {
    expect(parseAnsi("\x1b]0;title\x07hello")).toEqual([{ text: "hello", classes: "" }]);
    expect(parseAnsi("\x1b]8;;https://x\x1b\\link")).toEqual([{ text: "link", classes: "" }]);
  });

  test("other two-byte escapes (charset selects) are stripped", () => {
    expect(parseAnsi("a\x1b(Bb")).toEqual([{ text: "ab", classes: "" }]);
  });
});

describe("parseAnsi — truncated trailing escapes drop silently", () => {
  test.each(["abc\x1b", "abc\x1b[", "abc\x1b[31", "abc\x1b]0;ti"])("%j", (input) => {
    expect(parseAnsi(input)).toEqual([{ text: "abc", classes: "" }]);
  });
});

describe("hasAnsi", () => {
  test("positives: CSI and OSC intros", () => {
    expect(hasAnsi("x\x1b[31my")).toBe(true);
    expect(hasAnsi("\x1b]0;t\x07")).toBe(true);
  });

  test("negatives: plain text, bare ESC, bracket without ESC", () => {
    expect(hasAnsi("plain text")).toBe(false);
    expect(hasAnsi("\x1b")).toBe(false);
    expect(hasAnsi("[31m looks ansi but isn't")).toBe(false);
  });
});
