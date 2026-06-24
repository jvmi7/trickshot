// Claude provider: the default backend. Runs the native `claude` binary through
// the Claude Agent SDK against Anthropic's API (auth = the existing Claude Code
// login; there is no API key here). All the agent-loop machinery lives in the
// shared `createAnthropicProvider`; this file is just Claude's config — its
// default model and the tier->pips heuristic for its catalog.

import type { ModelInfo } from "../../shared/protocol";
import { type AnthropicProviderConfig, createAnthropicProvider } from "./anthropic-base";
import type { ProviderContext } from "./types";

// The default model a fresh session starts on (the UI can switch it per chat).
const DEFAULT_MODEL = "claude-opus-4-8";

// Claude tier -> comparison pips. This Claude-specific heuristic belongs with the
// provider that knows its own tiers (the UI renders the pips generically).
function ratings(value: string, displayName: string): ModelInfo["meta"] {
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

const CONFIG: AnthropicProviderConfig = {
  id: "claude",
  defaultModel: DEFAULT_MODEL,
  useSdkCatalog: true,
  ratings,
};

export function createClaudeProvider(ctx: ProviderContext) {
  return createAnthropicProvider(ctx, CONFIG);
}
