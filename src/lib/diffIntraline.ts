// Intraline (word-level) diff support for DiffView: pair up the -/+ lines of a
// changed run and find the common prefix/suffix of each pair, so only the
// segment that actually changed gets the strong highlight. Pure functions
// (no DOM, no escaping — DiffView owns rendering) so the edge cases are
// unit-testable.

/** Map each `del` row to its `add` partner for every "N deletions immediately
 *  followed by N additions" run — the classic modified-block shape. Unequal
 *  runs (pure adds, pure deletes, unbalanced blocks) pair nothing. Input is
 *  the per-row kind array; output maps row index → partner row index BOTH ways
 *  (del→add and add→del). */
export function pairChanges(kinds: readonly string[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < kinds.length) {
    if (kinds[i] !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < kinds.length && kinds[i] === "del") i++;
    const addStart = i;
    while (i < kinds.length && kinds[i] === "add") i++;
    const dels = addStart - delStart;
    const adds = i - addStart;
    if (dels === adds) {
      for (let k = 0; k < dels; k++) {
        pairs.set(delStart + k, addStart + k);
        pairs.set(addStart + k, delStart + k);
      }
    }
  }
  return pairs;
}

/** Common prefix/suffix lengths of two strings (suffix measured over the
 *  remainder after the prefix, so the regions never overlap). */
export function splitCommon(a: string, b: string): { pre: number; suf: number } {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

/** Whether an intraline highlight is worth painting for this pair: some edge
 *  must be shared (otherwise the whole line is the change — the row tint
 *  already says that). */
export function worthHighlighting(a: string, b: string, pre: number, suf: number): boolean {
  if (pre === 0 && suf === 0) return false;
  // A pair where the change swallows nearly the whole line reads better as a
  // plain full-row change.
  const midA = a.length - pre - suf;
  const midB = b.length - pre - suf;
  return midA < a.length || midB < b.length;
}
