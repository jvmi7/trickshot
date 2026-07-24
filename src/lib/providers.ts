// Webview-side provider display registry — the ONE home for provider-specific
// *presentation* knowledge in the UI (copy, account hints). Every component
// stays provider-neutral; anything that must say "Claude" (or "OpenAI",
// later) to the user is looked up here by the worktree's provider id
// (`providerByWorktree`, default DEFAULT_PROVIDER_ID). Display-only — must
// never import stores/api.

export interface ProviderDisplay {
  id: string;
  /** Ambient sign-in banner copy (Home, see AuthNotice). `command` (when
   *  set) renders as inline code between `before` and `after`. */
  signInNotice: { before: string; command?: string; after?: string };
  /** Tooltip footnote for the usage chip (what the numbers estimate). */
  usageNote: string;
}

export const DEFAULT_PROVIDER_ID = "claude";

const PROVIDERS: Record<string, ProviderDisplay> = {
  claude: {
    id: "claude",
    signInNotice: {
      before: "trickshot uses your Claude Code login — run ",
      command: "claude",
      after: " in a terminal to sign in",
    },
    usageNote: "Estimate from your Claude plan limits.",
  },
};

/** The display entry for a provider id, falling back to the default provider so
 *  an unknown/absent id never renders blank chrome. */
export function providerDisplay(id?: string | null): ProviderDisplay {
  return (
    PROVIDERS[id ?? DEFAULT_PROVIDER_ID] ?? (PROVIDERS[DEFAULT_PROVIDER_ID] as ProviderDisplay)
  );
}
