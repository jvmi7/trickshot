// ANSI SGR tokenizer — the ONE home for terminal-escape parsing in the webview.
// AnsiText.svelte renders the spans; app.css owns the `.ansi-*` classes and the
// `--app-ansi-0..15` tokens; conformance §8 guards that pairing. Hand-rolled on
// purpose: ansi_up-style libraries emit HTML with inline hex colors, which would
// need {@html} (against the CSP posture) and raw color literals (against the
// design-system conformance guards). Everything maps onto the 16 theme slots
// instead, so ANSI output retints with the active theme for free.
//
// Supported SGR: 0 reset; 1 bold / 2 dim / 3 italic / 4 underline (+ 22/23/24
// un-sets); 30-37 + 90-97 fg; 40-47 + 100-107 bg; 39/49 defaults; 38;5;n /
// 48;5;n 256-color (mapped to the nearest of the 16 base slots — see map256);
// 38;2;r;g;b / 48;2;… 24-bit (consumed but unstyled — no literal colors can
// exist in the class system, so it falls back to the default color). Every
// other CSI sequence (cursor movement, erase, …) and all OSC sequences
// (`ESC ] … BEL` / `ESC ] … ESC \`) are stripped. A truncated trailing escape
// at end of input is dropped silently.

export interface AnsiSpan {
  text: string;
  /** Space-joined `.ansi-*` class list; "" for plain text. */
  classes: string;
}

const ESC = 0x1b;

/** Cheap probe so plain text (the common case) skips parsing entirely. */
export function hasAnsi(text: string): boolean {
  return text.includes("\x1b[") || text.includes("\x1b]");
}

interface SgrState {
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function classesOf(s: SgrState): string {
  const out: string[] = [];
  if (s.fg !== null) out.push(`ansi-fg-${s.fg}`);
  if (s.bg !== null) out.push(`ansi-bg-${s.bg}`);
  if (s.bold) out.push("ansi-bold");
  if (s.dim) out.push("ansi-dim");
  if (s.italic) out.push("ansi-italic");
  if (s.underline) out.push("ansi-underline");
  return out.join(" ");
}

/** Map a 256-color index onto the 16 theme slots. Deliberately simple and
 *  deterministic (true rgb-distance against 16 themed slots is overkill):
 *  0-15 pass through; the 16-231 color cube maps by dominant hue — an r/g/b
 *  level (0-5) counts as "on" when it clears half the max channel, picking one
 *  of the 8 base hues, promoted to the bright variant when the max level is
 *  ≥ 4 (the cube's gray diagonal maps by lightness band instead); the 232-255
 *  grayscale ramp maps to black/bright-black/white/bright-white by band. */
function map256(n: number): number {
  if (Number.isNaN(n) || n < 0) return 0;
  if (n <= 15) return n;
  if (n <= 231) {
    const c = n - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    if (r === g && g === b) return r <= 1 ? 0 : r <= 3 ? 8 : r === 4 ? 7 : 15;
    const max = Math.max(r, g, b);
    const slot = (r * 2 > max ? 1 : 0) | (g * 2 > max ? 2 : 0) | (b * 2 > max ? 4 : 0);
    return max >= 4 ? slot + 8 : slot;
  }
  const level = Math.min(n, 255) - 232; // 0..23
  if (level < 6) return 0;
  if (level < 14) return 8;
  if (level < 21) return 7;
  return 15;
}

/** Apply one SGR parameter string ("1;31", "38;5;196", …) onto the state. */
function applySgr(s: SgrState, raw: string) {
  const parts = raw.split(";").map((p) => (p === "" ? 0 : Number.parseInt(p, 10)));
  for (let k = 0; k < parts.length; k++) {
    const n = parts[k];
    if (n === undefined || Number.isNaN(n)) continue;
    if (n === 0) {
      s.fg = null;
      s.bg = null;
      s.bold = false;
      s.dim = false;
      s.italic = false;
      s.underline = false;
    } else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) s.underline = true;
    else if (n === 22) {
      s.bold = false;
      s.dim = false;
    } else if (n === 23) s.italic = false;
    else if (n === 24) s.underline = false;
    else if (n >= 30 && n <= 37) s.fg = n - 30;
    else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
    else if (n >= 40 && n <= 47) s.bg = n - 40;
    else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
    else if (n === 39) s.fg = null;
    else if (n === 49) s.bg = null;
    else if (n === 38 || n === 48) {
      const mode = parts[k + 1];
      if (mode === 5) {
        const slot = map256(parts[k + 2] ?? 0);
        if (n === 38) s.fg = slot;
        else s.bg = slot;
        k += 2;
      } else if (mode === 2) {
        // 24-bit: consumed but unstyled — fall back to the default color.
        if (n === 38) s.fg = null;
        else s.bg = null;
        k += 4;
      } else {
        // Malformed extended-color sequence — stop processing this SGR run.
        break;
      }
    }
    // Any other SGR code (5 blink, 7 reverse, …) is ignored.
  }
}

/** Tokenize `text` into styled spans. Attributes accumulate across escapes
 *  until reset/un-set; stripped sequences never split a span (adjacent
 *  same-style text stays merged). */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const state: SgrState = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };
  let classes = "";
  let buf = "";
  const flush = () => {
    if (buf) {
      spans.push({ text: buf, classes });
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== ESC) {
      // Fast path: consume the whole plain run up to the next escape.
      const next = text.indexOf("\x1b", i);
      const end = next === -1 ? text.length : next;
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    const intro = text.charCodeAt(i + 1); // NaN at end-of-input
    if (intro === 0x5b /* [ — CSI */) {
      // Params/intermediates are 0x20-0x3F; the first 0x40-0x7E byte is final.
      let j = i + 2;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) break;
        j++;
      }
      if (j >= text.length) break; // truncated trailing escape — drop
      if (text.charCodeAt(j) === 0x6d /* m — SGR */) {
        applySgr(state, text.slice(i + 2, j));
        const next = classesOf(state);
        if (next !== classes) {
          flush();
          classes = next;
        }
      }
      // Any other final byte (cursor movement, erase, …) is stripped.
      i = j + 1;
    } else if (intro === 0x5d /* ] — OSC */) {
      // Runs to BEL (0x07) or ST (ESC \).
      let j = i + 2;
      let after = -1;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c === 0x07) {
          after = j + 1;
          break;
        }
        if (c === ESC && text.charCodeAt(j + 1) === 0x5c) {
          after = j + 2;
          break;
        }
        j++;
      }
      if (after === -1) break; // truncated trailing escape — drop
      i = after;
    } else if (Number.isNaN(intro)) {
      break; // lone trailing ESC — drop
    } else if (intro >= 0x20 && intro <= 0x2f) {
      // ESC + intermediate(s) + final (charset designates like `ESC ( B`) —
      // strip the intermediates and the one final byte.
      let j = i + 2;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c < 0x20 || c > 0x2f) break;
        j++;
      }
      i = j >= text.length ? text.length : j + 1; // truncated → drop
    } else {
      // Other two-byte escape (RIS, keypad modes, …) — strip ESC + one byte.
      i += 2;
    }
  }
  flush();
  return spans;
}
