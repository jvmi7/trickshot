// Webview-side provider display registry — the ONE home for provider-specific
// *presentation* knowledge in the UI (copy, auth-failure recognition, account
// hints). Every component stays provider-neutral; anything that must say
// "Claude" (or "OpenAI", later) to the user is looked up here by the
// worktree's provider id (`providerByWorktree`, default DEFAULT_PROVIDER_ID).
// Display-only — must never import stores/api.

export interface ProviderDisplay {
  id: string;
  displayName: string;
  /** Matches error text that reads like THIS provider's auth failure. Deliberately
   *  loose — a match costs a friendlier message; a false negative costs only the
   *  raw error the user would have seen anyway. */
  authErrorPattern: RegExp;
  /** Transcript-error copy substituted for a raw auth-failure error. */
  authErrorMessage: string;
  /** Ambient sign-in banner copy (Welcome, see AuthNotice). `command` (when
   *  set) renders as inline code between `before` and `after`. */
  signInNotice: { before: string; command?: string; after?: string };
  /** Tooltip footnote for the usage chip (what the numbers estimate). */
  usageNote: string;
}

export const DEFAULT_PROVIDER_ID = "claude";

const PROVIDERS: Record<string, ProviderDisplay> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    authErrorPattern: /log ?in|logged|authenticat|oauth|api key|credential|401|unauthorized/i,
    authErrorMessage:
      "not signed in to Claude Code — run `claude` in a terminal, then click the worktree to restart",
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
