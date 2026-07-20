// Friendly auto-generated worktree branch names ("swift-harbor") so creating
// a workspace is one click — no naming prompt (Conductor-style). Local and
// instant (no model call; `generate_branch_name` names DIFFS, which a fresh
// worktree doesn't have). Pure + injectable rand, so collision behavior is
// unit-testable.

const ADJECTIVES = [
  "amber",
  "bold",
  "brisk",
  "calm",
  "civic",
  "clear",
  "cobalt",
  "coral",
  "crisp",
  "deft",
  "dusk",
  "eager",
  "early",
  "ember",
  "fleet",
  "gold",
  "green",
  "hazel",
  "ivory",
  "jade",
  "keen",
  "lively",
  "lunar",
  "mellow",
  "misty",
  "noble",
  "north",
  "ochre",
  "prime",
  "quiet",
  "rapid",
  "ripe",
  "sage",
  "sharp",
  "silent",
  "solar",
  "spry",
  "swift",
  "tidal",
  "vivid",
];

const NOUNS = [
  "anchor",
  "aspen",
  "atlas",
  "basin",
  "beacon",
  "birch",
  "bluff",
  "brook",
  "canyon",
  "cedar",
  "comet",
  "cove",
  "crag",
  "delta",
  "drift",
  "dune",
  "falcon",
  "fjord",
  "garnet",
  "glade",
  "grove",
  "harbor",
  "heron",
  "inlet",
  "juniper",
  "lagoon",
  "marsh",
  "mesa",
  "meadow",
  "orchard",
  "osprey",
  "otter",
  "pine",
  "quarry",
  "reef",
  "ridge",
  "sparrow",
  "summit",
  "thicket",
  "wren",
];

/** Generate a branch name not present in `taken`. Tries fresh pairs first,
 *  then falls back to numeric suffixes (deterministic under a stubbed rand). */
export function generateWorktreeName(
  taken: ReadonlySet<string>,
  rand: () => number = Math.random,
): string {
  const pick = (list: string[]) => list[Math.floor(rand() * list.length)] ?? list[0] ?? "wt";
  let name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  for (let i = 0; i < 16 && taken.has(name); i++) {
    name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  }
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffixed = `${name}-${n}`;
    if (!taken.has(suffixed)) return suffixed;
  }
}
