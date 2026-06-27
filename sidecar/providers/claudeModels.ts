// Claude model defaults + the tier->comparison-pip heuristic. This Claude-specific
// ranking used to live in the UI (ModelSelector); it belongs with the provider
// that knows its own tiers. The UI renders the pips generically (it does NOT infer
// tiers), so a different provider supplies its own `meta` or omits it.

import type { ModelInfo } from "../../shared/protocol";

// The default model a fresh session starts on (the UI can switch it per chat).
export const DEFAULT_MODEL = "claude-opus-4-8";

/** Map a Claude model id/name to comparison pips (reasoning/speed/value/context). */
export function ratings(value: string, displayName: string): ModelInfo["meta"] {
  const s = `${value} ${displayName}`.toLowerCase();
  const context = /1m|\[1m\]/.test(s) ? 4 : 2;
  const r = s.includes("haiku")
    ? { reasoning: 2, speed: 4, value: 4 }
    : s.includes("opus")
      ? { reasoning: 4, speed: 2, value: 1 }
      : { reasoning: 3, speed: 3, value: 3 }; // sonnet / default / unknown
  return [
    { label: "Reasoning", score: r.reasoning },
    { label: "Speed", score: r.speed },
    { label: "Value", score: r.value },
    { label: "Context", score: context },
  ];
}
