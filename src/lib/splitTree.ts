// The grid layout's split tree (tmux-style): each worktree's grid is a binary
// tree — a leaf is one chat, a node splits its rect 50/50 into two children
// (row = side-by-side, column = stacked). Right-click → split replaces "add
// chrome": the new chat takes the chosen half of the clicked cell. Pure,
// deterministic logic (tested); rendering flattens the tree into ONE flat CSS
// grid via treeToGrid so cells stay direct children of .chat-grid — the trail
// silhouette's union query and childList observers work unchanged, and
// nothing ever subtree-observes the xterm DOM.

export type SplitNode = { chat: string } | { dir: "row" | "column"; a: SplitNode; b: SplitNode };

export type SplitWhere = "up" | "down" | "left" | "right";

/** Runtime shape guard for persisted trees (recursive; depth-capped so a
 *  hostile/corrupt blob can't stack-overflow the load path). */
export function isSplitNode(v: unknown, depth = 0): v is SplitNode {
  if (depth > 32 || typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  if (typeof n.chat === "string") return true;
  return (
    (n.dir === "row" || n.dir === "column") &&
    isSplitNode(n.a, depth + 1) &&
    isSplitNode(n.b, depth + 1)
  );
}

/** Leaf chat ids in document order (a before b). */
export function leavesOf(tree: SplitNode): string[] {
  if ("chat" in tree) return [tree.chat];
  return [...leavesOf(tree.a), ...leavesOf(tree.b)];
}

/** Replace the target leaf with a split of (target, newChat): up/left place
 *  the NEW chat first (above/before), down/right place it second. Returns the
 *  same node when the target isn't found (identity-preserving no-op). */
export function splitLeaf(
  tree: SplitNode,
  targetChat: string,
  where: SplitWhere,
  newChat: string,
): SplitNode {
  if ("chat" in tree) {
    if (tree.chat !== targetChat) return tree;
    const dir = where === "left" || where === "right" ? "row" : "column";
    const fresh: SplitNode = { chat: newChat };
    return where === "left" || where === "up"
      ? { dir, a: fresh, b: tree }
      : { dir, a: tree, b: fresh };
  }
  const a = splitLeaf(tree.a, targetChat, where, newChat);
  const b = splitLeaf(tree.b, targetChat, where, newChat);
  return a === tree.a && b === tree.b ? tree : { dir: tree.dir, a, b };
}

/** Swap two leaves' positions (drag-and-drop rearrange): the mosaic's
 *  geometry is untouched — the two chats trade rects. Identity-preserving
 *  no-op unless BOTH ids are present (a half-found swap would teleport one
 *  chat and drop the other). */
export function swapLeaves(tree: SplitNode, a: string, b: string): SplitNode {
  if (a === b) return tree;
  const ids = leavesOf(tree);
  if (!ids.includes(a) || !ids.includes(b)) return tree;
  const rename = (n: SplitNode): SplitNode => {
    if ("chat" in n) {
      if (n.chat === a) return { chat: b };
      if (n.chat === b) return { chat: a };
      return n;
    }
    const na = rename(n.a);
    const nb = rename(n.b);
    return na === n.a && nb === n.b ? n : { dir: n.dir, a: na, b: nb };
  };
  return rename(tree);
}

/** Drop leaves not in keepIds; a split with one dead side collapses to the
 *  surviving side (the sibling reclaims the space). Returns null when nothing
 *  survives. Identity-preserving when nothing changed. */
export function prune(tree: SplitNode, keepIds: ReadonlySet<string>): SplitNode | null {
  if ("chat" in tree) return keepIds.has(tree.chat) ? tree : null;
  const a = prune(tree.a, keepIds);
  const b = prune(tree.b, keepIds);
  if (a && b) return a === tree.a && b === tree.b ? tree : { dir: tree.dir, a, b };
  return a ?? b;
}

/** Balanced default mosaic for a plain list: halve the list recursively,
 *  alternating row/column (4 chats ≈ a 2×2). */
export function defaultTree(ids: readonly string[], dir: "row" | "column" = "row"): SplitNode {
  if (ids.length === 1) {
    const only = ids[0] ?? "";
    return { chat: only };
  }
  const mid = Math.ceil(ids.length / 2);
  const next = dir === "row" ? "column" : "row";
  return {
    dir,
    a: defaultTree(ids.slice(0, mid), next),
    b: defaultTree(ids.slice(mid), next),
  };
}

/** Reconcile a (possibly stale/absent) persisted tree with the live chat
 *  list: prune dead leaves, append chats the tree doesn't know by splitting
 *  the LAST leaf rightward. The one entry point renders should use. */
export function heal(tree: SplitNode | undefined, ids: readonly string[]): SplitNode | null {
  if (ids.length === 0) return null;
  const keep = new Set(ids);
  let t = tree && isSplitNode(tree) ? prune(tree, keep) : null;
  if (!t) return defaultTree(ids);
  for (const id of ids) {
    if (!leavesOf(t).includes(id)) {
      const last = leavesOf(t).at(-1);
      t = last ? splitLeaf(t, last, "right", id) : { chat: id };
    }
  }
  return t;
}

export interface GridCell {
  chat: string;
  /** Ready-to-inline `grid-area` value (line numbers: rowStart / colStart / rowEnd / colEnd). */
  area: string;
}
export interface GridLayout {
  /** Ready-to-inline `grid-template-columns` / `grid-template-rows` fr tracks. */
  cols: string;
  rows: string;
  cells: GridCell[];
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Flatten the tree into one flat CSS grid: leaf rects in [0,1]² → the unique
 *  x/y cuts become fr tracks, each leaf spans its track range. Spanned cells
 *  swallow interior gaps, so arbitrary mosaics render with plain `gap`. */
export function treeToGrid(tree: SplitNode): GridLayout {
  const rects: { chat: string; r: Rect }[] = [];
  const walk = (n: SplitNode, r: Rect) => {
    if ("chat" in n) {
      rects.push({ chat: n.chat, r });
      return;
    }
    if (n.dir === "row") {
      const mx = (r.x0 + r.x1) / 2;
      walk(n.a, { ...r, x1: mx });
      walk(n.b, { ...r, x0: mx });
    } else {
      const my = (r.y0 + r.y1) / 2;
      walk(n.a, { ...r, y1: my });
      walk(n.b, { ...r, y0: my });
    }
  };
  walk(tree, { x0: 0, y0: 0, x1: 1, y1: 1 });

  // Halving yields dyadic coords, but round before uniquing so float noise
  // can't mint phantom tracks.
  const snap = (v: number) => Math.round(v * 1e6) / 1e6;
  const xs = [...new Set(rects.flatMap(({ r }) => [snap(r.x0), snap(r.x1)]))].sort((p, q) => p - q);
  const ys = [...new Set(rects.flatMap(({ r }) => [snap(r.y0), snap(r.y1)]))].sort((p, q) => p - q);
  const frs = (cuts: number[]) =>
    cuts
      .slice(1)
      .map((c, i) => `${Math.round((c - (cuts[i] ?? 0)) * 1000)}fr`)
      .join(" ");
  const cells = rects.map(({ chat, r }) => ({
    chat,
    area: `${ys.indexOf(snap(r.y0)) + 1} / ${xs.indexOf(snap(r.x0)) + 1} / ${
      ys.indexOf(snap(r.y1)) + 1
    } / ${xs.indexOf(snap(r.x1)) + 1}`,
  }));
  return { cols: frs(xs), rows: frs(ys), cells };
}
