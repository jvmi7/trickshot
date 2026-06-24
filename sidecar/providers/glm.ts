// GLM (Z.ai) provider. Z.ai exposes an Anthropic-compatible endpoint, so this is
// the SAME native `claude` binary + agent loop as the Claude provider — only the
// endpoint differs. The host (Rust `start_session`) points the binary at Z.ai by
// setting ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN in the sidecar env when
// AGENT_PROVIDER=glm; nothing endpoint-specific lives here. The SDK can't
// enumerate Z.ai's models, so we advertise a static catalog instead.

import type { ModelInfo } from "../../shared/protocol";
import { type AnthropicProviderConfig, createAnthropicProvider } from "./anthropic-base";
import type { ProviderContext } from "./types";

const DEFAULT_MODEL = "glm-5.2";

// Static catalog (the SDK's supportedModels can't see Z.ai's lineup). Pips mirror
// the Claude provider's axes so the selector renders one consistent grid.
const CATALOG: ModelInfo[] = [
  {
    value: "glm-5.2",
    displayName: "GLM-5.2",
    description: "Z.ai GLM-5.2 (Anthropic-compatible endpoint)",
    meta: [
      { label: "Reasoning", score: 4 },
      { label: "Speed", score: 3 },
      { label: "Value", score: 4 },
      { label: "Context", score: 4 }, // 1M context window
    ],
  },
];

const CONFIG: AnthropicProviderConfig = {
  id: "glm",
  defaultModel: DEFAULT_MODEL,
  useSdkCatalog: false,
  staticCatalog: CATALOG,
};

export function createGlmProvider(ctx: ProviderContext) {
  return createAnthropicProvider(ctx, CONFIG);
}
