// Webview-side provider display registry — the ONE home for provider-specific
// *presentation* knowledge in the UI (copy, auth-failure recognition, account
// hints). The wire protocol and every component stay provider-neutral; anything
// that must say "Claude" (or "OpenAI", later) to the user is looked up here by
// the worktree's provider id (`providerByWorktree`, default DEFAULT_PROVIDER_ID).
// The sidecar-side counterpart is `sidecar/providers/registry.ts` (behavior);
// this registry is display-only and must never import stores/api.
//
// Why this lives in the webview at all: auth failures reach the UI on TWO paths —
// in-band `{kind:"error"}` events from the provider AND Rust-side session-death
// stderr tails (`handleSessionStatus`) that never pass through a provider adapter.
// Only the webview sees both, so the "does this error mean sign in?" matcher and
// its friendly copy live here, keyed by provider.

export interface ProviderDisplay {
  id: string;
  displayName: string;
  /** Matches error text that reads like THIS provider's auth failure. Deliberately
   *  loose — a match costs a friendlier message; a false negative costs only the
   *  raw error the user would have seen anyway. */
  authErrorPattern: RegExp;
  /** Transcript-error copy substituted for a raw auth-failure error. */
  authErrorMessage: string;
  /** Ambient sign-in banner copy (Welcome + the composer banner, see AuthNotice).
   *  `command` (when set) renders as inline code between `before` and `after`. */
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
