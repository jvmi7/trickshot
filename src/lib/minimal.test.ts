import { describe, expect, test } from "bun:test";
import { MAX_BUBBLES, MINIMAL_MARKER, splitSummary } from "./minimal";

describe("splitSummary", () => {
  test("splits body and bubbles at a marker on its own line", () => {
    const text = `Full prose here.\nMore detail.\n${MINIMAL_MARKER}\ndone, shipped it\nlet me know`;
    const { body, bubbles } = splitSummary(text);
    expect(body).toBe("Full prose here.\nMore detail.");
    expect(bubbles).toEqual(["done, shipped it", "let me know"]);
  });

  test("tolerates whitespace around the marker line", () => {
    const { body, bubbles } = splitSummary(`prose\n  ${MINIMAL_MARKER}  \nok`);
    expect(body).toBe("prose");
    expect(bubbles).toEqual(["ok"]);
  });

  test("no marker → full text as body, no bubbles", () => {
    const { body, bubbles } = splitSummary("just a normal reply\nwith lines");
    expect(body).toBe("just a normal reply\nwith lines");
    expect(bubbles).toEqual([]);
  });

  test("an INLINE marker mention does not truncate the message", () => {
    // The regression the own-line rule guards: quoting the sentinel mid-prose
    // (discussing minimal.ts, a code fence) must not hide everything after it.
    const text = `The sentinel is ${MINIMAL_MARKER} and it fences the recap.\nMore prose after.`;
    const { body, bubbles } = splitSummary(text);
    expect(body).toBe(text);
    expect(bubbles).toEqual([]);
  });

  test("uses the LAST own-line marker when several appear", () => {
    const text = `prose\n${MINIMAL_MARKER}\nquoted earlier recap\nmore prose\n${MINIMAL_MARKER}\nreal recap`;
    const { body, bubbles } = splitSummary(text);
    expect(body).toBe(`prose\n${MINIMAL_MARKER}\nquoted earlier recap\nmore prose`);
    expect(bubbles).toEqual(["real recap"]);
  });

  test("caps bubbles at MAX_BUBBLES and drops blank lines", () => {
    const lines = ["one", "", "two", "three", "four"];
    const { bubbles } = splitSummary(`prose\n${MINIMAL_MARKER}\n${lines.join("\n")}`);
    expect(bubbles).toEqual(["one", "two", "three"].slice(0, MAX_BUBBLES));
    expect(bubbles.length).toBeLessThanOrEqual(MAX_BUBBLES);
  });

  test("marker as the last line → empty bubbles, trimmed body", () => {
    const { body, bubbles } = splitSummary(`prose\n${MINIMAL_MARKER}\n`);
    expect(body).toBe("prose");
    expect(bubbles).toEqual([]);
  });

  test("marker as the first line → empty body, bubbles only", () => {
    const { body, bubbles } = splitSummary(`${MINIMAL_MARKER}\nhey`);
    expect(body).toBe("");
    expect(bubbles).toEqual(["hey"]);
  });
});
