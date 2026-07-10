// Animated composer placeholder (DOM/interaction helper, the customScroll.ts
// precedent): the placeholder text deletes itself char-by-char on focus — so the
// field reads empty when you click in — and retypes itself on blur if the input
// is still empty. Clicking into the middle mimics select-to-end → delete →
// backspace: the text RIGHT of the click is highlighted (theme selection style),
// held briefly, deleted as one chunk, then the left part backspaces.
//
// Store-free and argument-driven so it stays a generic helper: the caller owns
// the real input state (`active`/`retype` flags come in per call) and renders
// `text`/`sel` in its own overlay; this module owns only the animation state
// machine. A `.svelte.ts` module so the returned getters are reactive `$state`.

export function createAnimatedPlaceholder(opts: {
  /** The full placeholder text (always retyped/backspaced as its own prefix). */
  placeholder: string;
  /** The rendered overlay element — for per-glyph click hit-testing. */
  getEl: () => HTMLElement | null;
  /** How long the highlighted chunk stays selected before it's deleted — brief,
   *  so the highlight registers without a noticeable pause before the backspace. */
  highlightMs?: number;
}) {
  const { placeholder, getEl, highlightMs = 95 } = opts;

  let ph = $state(placeholder); // visible (left) placeholder text, backspaced char-by-char
  let phSel = $state(""); // the highlighted right-hand chunk (shown, then deleted in one go)
  let phTimer: ReturnType<typeof setInterval> | undefined; // backspace / type-back loop
  let phSelTimer: ReturnType<typeof setTimeout> | undefined; // delay before deleting phSel

  function clearTimers() {
    clearInterval(phTimer);
    clearTimeout(phSelTimer);
  }

  // Char-by-char backspace of the (left) placeholder text.
  function backspace() {
    clearInterval(phTimer);
    phTimer = setInterval(() => {
      ph = ph.slice(0, -1);
      if (!ph) clearInterval(phTimer);
    }, 9);
  }

  // Map a click's x to the nearest character boundary in the rendered placeholder
  // (measured per-glyph so it's correct for any font/variable widths).
  function indexAt(clientX: number): number {
    const node = getEl()?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return placeholder.length;
    const len = (node as Text).length;
    const range = document.createRange();
    for (let i = 0; i < len; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return len;
  }

  return {
    /** Visible (left) placeholder text. */
    get text() {
      return ph;
    },
    /** The highlighted right-hand chunk (render with the selection style). */
    get sel() {
      return phSel;
    },
    /** Pointer-down on the input. Fires before focus, so `focus()` defers to the
     *  highlight-then-delete sequence this may start. `active` = the overlay is
     *  actually showing the placeholder (caller's input is empty and enabled). */
    pointerdown(e: PointerEvent, active: boolean) {
      if (!active || ph !== placeholder || phSel) return;
      const i = indexAt(e.clientX);
      if (i >= placeholder.length) return; // clicked at/after the end → focus() full-backspaces
      clearTimers();
      ph = placeholder.slice(0, i);
      phSel = placeholder.slice(i);
      phSelTimer = setTimeout(() => {
        phSel = ""; // delete the highlighted chunk in one go
        backspace(); // then backspace the rest from the cursor
      }, highlightMs);
    },
    /** Focus: start backspacing the placeholder away. */
    focus() {
      // A click already kicked off the highlight-then-delete sequence — let it run.
      if (phSel) return;
      backspace();
    },
    /** Blur: cancel any run; if `retype`, type the placeholder back in char by
     *  char (continues from wherever the delete left off, since `ph` is always a
     *  prefix of the placeholder). */
    blur(retype: boolean) {
      clearTimers();
      phSel = "";
      if (!retype) return; // a real message is showing; leave the placeholder hidden
      phTimer = setInterval(() => {
        ph = placeholder.slice(0, ph.length + 1);
        if (ph === placeholder) clearInterval(phTimer);
      }, 9);
    },
    /** onDestroy hook — stop the timers so a torn-down composer can't tick. */
    destroy: clearTimers,
  };
}
