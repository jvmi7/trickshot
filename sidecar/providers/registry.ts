// Provider registry. Map an id -> factory; `core.ts` picks one via the
// AGENT_PROVIDER env (set by Rust `start_session`), defaulting to "claude".
// To add a provider: implement AgentProvider in `./<name>.ts` and add it here.

import { createClaudeProvider } from "./claude";
import type { AgentProvider, ProviderContext, ProviderFactory } from "./types";

const PROVIDERS: Record<string, ProviderFactory> = {
  claude: createClaudeProvider,
};

export const DEFAULT_PROVIDER = "claude";

/** Build the provider for `id`, falling back to the default if unknown. */
export function createProvider(id: string, ctx: ProviderContext): AgentProvider {
  const factory = PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER];
  if (!factory) throw new Error(`no provider registered for "${DEFAULT_PROVIDER}"`);
  return factory(ctx);
}
