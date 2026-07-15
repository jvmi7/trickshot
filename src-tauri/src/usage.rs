//! Subscription usage windows (the rolling ~5-hour session limit + the weekly
//! limit), read from the same undocumented OAuth endpoint the Claude Code CLI's
//! `/usage` command uses. There is NO API key in this app (see CLAUDE.md); auth
//! is the user's existing Claude Code login, so we reuse its OAuth token.
//!
//! This is a deliberately isolated, best-effort feature: the endpoint is
//! undocumented and aggressively rate-limited, so EVERY failure path maps to an
//! `Err(String)` the UI renders as "usage unavailable" rather than crashing, and
//! the caller (stores.ts) throttles refreshes instead of polling.
//!
//! The WIRE shape is provider-neutral (named `windows`); only the parsing of
//! the Anthropic response is Claude-specific.

use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Undocumented endpoint behind the CLI's `/usage`. Returns the live subscription
/// window utilization for the authenticated Claude plan.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Required beta header; without it the endpoint rejects the OAuth token.
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Fallback User-Agent version if we can't read the installed `claude` version.
/// The endpoint rate-limits far more aggressively without a `claude-code/*` UA.
const UA_FALLBACK_VERSION: &str = "2.0.0";

/// One usage window, provider-neutral. Mirrored field-for-field in `types.ts`
/// (`UsageWindow`); results stay snake_case per the boundary convention.
#[derive(Serialize)]
pub struct UsageWindow {
    /// Human-readable window name (e.g. "5-hour window", "Weekly").
    pub label: String,
    /// Percent of the window consumed (0–100), as returned by the endpoint.
    pub utilization: Option<f64>,
    /// ISO-8601 timestamp when this window resets.
    pub resets_at: Option<String>,
}

/// The usage windows the UI shows, provider-neutral. Mirrored in `types.ts`
/// (`UsageInfo`).
#[derive(Serialize)]
pub struct UsageInfo {
    pub windows: Vec<UsageWindow>,
}

/// The Claude-specific subset of the `/usage` response we read. Private: the
/// raw provider shape never crosses the IPC boundary — it's mapped to the
/// neutral `UsageInfo`. The response carries many other (often null) buckets
/// we intentionally ignore.
#[derive(Deserialize, Default)]
struct ClaudeUsage {
    five_hour: Option<ClaudeWindow>,
    seven_day: Option<ClaudeWindow>,
}

#[derive(Deserialize, Default)]
struct ClaudeWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

/// Map the Claude response into the neutral named-window shape, skipping
/// absent windows. Pure, unit-tested.
fn neutral_usage(raw: ClaudeUsage) -> UsageInfo {
    let window = |label: &str, w: ClaudeWindow| UsageWindow {
        label: label.to_string(),
        utilization: w.utilization,
        resets_at: w.resets_at,
    };
    let mut windows = Vec::new();
    if let Some(w) = raw.five_hour {
        windows.push(window("5-hour window", w));
    }
    if let Some(w) = raw.seven_day {
        windows.push(window("Weekly", w));
    }
    UsageInfo { windows }
}

/// Usage/auth are provider-specific ACCOUNT probes, unlike the rest of the
/// provider-neutral surface — this arg is the dispatch point when a second
/// provider lands. `None` (older callers) and "claude" both mean the existing
/// Claude Code login probes below; anything else fails loudly rather than
/// silently reporting Claude's numbers for another provider.
pub(crate) fn ensure_known_provider(provider: Option<&str>) -> Result<(), String> {
    match provider {
        None | Some("claude") => Ok(()),
        Some(p) => Err(format!("no usage/auth probe for provider \"{p}\"")),
    }
}

/// Shape of the Claude Code credentials store (keychain item or file).
#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: OauthTokens,
}

#[derive(Deserialize)]
struct OauthTokens {
    #[serde(rename = "accessToken")]
    access_token: String,
}

/// Why the credentials could not be read. `Missing` is the definitive
/// "no Claude Code login anywhere" signal (`check_auth` maps it to `false`);
/// `Other` is ambiguous (HOME unset, keychain spawn failure, unreadable file)
/// and must never be reported as logged-out.
#[derive(Debug)]
enum CredError {
    Missing(String),
    Other(String),
}

impl CredError {
    fn message(self) -> String {
        match self {
            CredError::Missing(m) | CredError::Other(m) => m,
        }
    }
}

/// Extract the access token from the raw credentials-store JSON. A store that
/// exists but doesn't parse means the login is gone/incomplete, not an
/// environment problem — treat it as definitively logged-out (`Missing`).
/// Pure, unit-tested: check_auth's false/error split depends on this
/// classification.
fn parse_access_token(raw: &str) -> Result<String, CredError> {
    let creds: Credentials = serde_json::from_str(raw)
        .map_err(|e| CredError::Missing(format!("could not parse Claude credentials: {e}")))?;
    Ok(creds.claude_ai_oauth.access_token)
}

/// Read the OAuth access token from where the Claude Code login stores it.
/// macOS keeps the *live* (auto-refreshed) token in the login keychain — the
/// on-disk `~/.claude/.credentials.json` there is often stale — so prefer the
/// keychain and fall back to the file. Other platforms use the file directly.
/// BLOCKING (keychain subprocess / file read) — call via spawn_blocking.
fn read_access_token() -> Result<String, CredError> {
    parse_access_token(&read_credentials_json()?)
}

#[cfg(target_os = "macos")]
fn read_credentials_json() -> Result<String, CredError> {
    // Live token: `security find-generic-password -s "Claude Code-credentials" -w`.
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|e| CredError::Other(format!("failed to read keychain: {e}")))?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Ok(s);
        }
    }
    // Fall back to the on-disk credentials if the keychain item is absent.
    read_credentials_file()
}

#[cfg(not(target_os = "macos"))]
fn read_credentials_json() -> Result<String, CredError> {
    read_credentials_file()
}

fn read_credentials_file() -> Result<String, CredError> {
    let home =
        std::env::var("HOME").map_err(|_| CredError::Other("HOME is not set".to_string()))?;
    let path = format!("{home}/.claude/.credentials.json");
    std::fs::read_to_string(&path).map_err(|e| {
        let msg = format!("could not read {path}: {e} (is Claude Code logged in?)");
        // Absent file = no login on this machine (definitive); any other io
        // error (permissions, etc.) is ambiguous.
        if e.kind() == std::io::ErrorKind::NotFound {
            CredError::Missing(msg)
        } else {
            CredError::Other(msg)
        }
    })
}

/// Whether a login exists on this machine for `provider` (None = "claude").
/// `Ok(true)` = credentials found (NOT a validity guarantee — an expired token
/// still reports `true`; the real check is the first authenticated call).
/// `Ok(false)` = definitively no credentials (keychain item absent AND no
/// credentials file). `Err` = ambiguous environment failure — the UI stays
/// silent rather than showing a false "not signed in" alarm. Local reads only;
/// never hits the network — but the keychain read spawns a subprocess, so it
/// runs via spawn_blocking, off the async runtime's worker.
#[tauri::command]
pub async fn check_auth(provider: Option<String>) -> Result<bool, String> {
    ensure_known_provider(provider.as_deref())?;
    let result = tauri::async_runtime::spawn_blocking(read_access_token)
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(_) => Ok(true),
        Err(CredError::Missing(_)) => Ok(false),
        Err(e) => Err(e.message()),
    }
}

/// Best-effort `claude-code/<version>` User-Agent. We try the installed CLI's
/// version and fall back to a constant — the endpoint only needs a `claude-code/*`
/// UA to avoid its stricter rate-limit bucket, not an exact match.
/// Parse the CLI's `--version` stdout into a bare version string. The output
/// looks like `"2.1.193 (Claude Code)"`, so we take the first whitespace-delimited
/// token. `None` when there is no token (empty / whitespace-only output).
fn parse_cli_version(stdout: &str) -> Option<String> {
    stdout.split_whitespace().next().map(|v| v.to_string())
}

/// The UA string, computed ONCE per app run (shelling `claude --version` per
/// call was pure waste — the installed version doesn't change under us).
/// BLOCKING on first call (subprocess) — call via spawn_blocking.
fn user_agent() -> &'static str {
    static UA: OnceLock<String> = OnceLock::new();
    UA.get_or_init(|| {
        let version = Command::new("claude")
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| parse_cli_version(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_else(|| UA_FALLBACK_VERSION.to_string());
        format!("claude-code/{version}")
    })
}

/// The shared reqwest client (connection pool + TLS config built once, not
/// per call).
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Fetch the current subscription usage windows for `provider` (None =
/// "claude"). Errors (no login, expired token, rate limit, network) surface as
/// `Err(String)` for the UI to show as unavailable — never a panic. Async: the
/// network call runs on Tauri's runtime; the blocking credential/UA reads run
/// via spawn_blocking so they never stall an async worker.
#[tauri::command]
pub async fn get_usage(provider: Option<String>) -> Result<UsageInfo, String> {
    ensure_known_provider(provider.as_deref())?;
    // One spawn_blocking for both blocking reads (keychain subprocess + the
    // first-call `claude --version` behind the UA cache).
    let (token, ua) = tauri::async_runtime::spawn_blocking(|| {
        let token = read_access_token().map_err(CredError::message)?;
        Ok::<_, String>((token, user_agent()))
    })
    .await
    .map_err(|e| e.to_string())??;
    let resp = http_client()
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", OAUTH_BETA)
        .header(reqwest::header::USER_AGENT, ua)
        .send()
        .await
        .map_err(|e| format!("usage request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // 401 = stale/expired token (re-login), 429 = rate limited (back off).
        return Err(format!("usage endpoint returned {status}"));
    }
    let raw = resp
        .json::<ClaudeUsage>()
        .await
        .map_err(|e| format!("could not parse usage response: {e}"))?;
    Ok(neutral_usage(raw))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_known_provider, neutral_usage, parse_access_token, parse_cli_version, ClaudeUsage,
        ClaudeWindow, CredError,
    };

    #[test]
    fn parses_first_token_as_version() {
        assert_eq!(
            parse_cli_version("2.1.193 (Claude Code)").as_deref(),
            Some("2.1.193")
        );
    }

    #[test]
    fn tolerates_a_bare_version_with_trailing_newline() {
        assert_eq!(parse_cli_version("2.0.0\n").as_deref(), Some("2.0.0"));
    }

    #[test]
    fn empty_or_whitespace_only_yields_none() {
        assert_eq!(parse_cli_version(""), None);
        assert_eq!(parse_cli_version("   \n  "), None);
    }

    // ---- credential classification (check_auth's false/error split) ----

    #[test]
    fn valid_credentials_yield_the_token() {
        let raw = r#"{ "claudeAiOauth": { "accessToken": "tok-123" } }"#;
        assert_eq!(parse_access_token(raw).unwrap(), "tok-123");
    }

    #[test]
    fn unparseable_credentials_classify_as_missing() {
        // A store that EXISTS but doesn't parse = the login is gone/incomplete
        // — check_auth must report a definitive `false`, never an ambiguous Err.
        assert!(matches!(
            parse_access_token("not json"),
            Err(CredError::Missing(_))
        ));
        // Parses as JSON but lacks the oauth section: same classification.
        assert!(matches!(
            parse_access_token(r#"{ "somethingElse": true }"#),
            Err(CredError::Missing(_))
        ));
    }

    // ---- provider dispatch ----

    #[test]
    fn provider_gate_accepts_claude_and_default() {
        assert!(ensure_known_provider(None).is_ok());
        assert!(ensure_known_provider(Some("claude")).is_ok());
    }

    #[test]
    fn provider_gate_rejects_unknown_providers() {
        let err = ensure_known_provider(Some("gemini")).unwrap_err();
        assert!(err.contains("gemini"));
    }

    // ---- Claude → neutral window mapping ----

    #[test]
    fn neutral_usage_labels_and_orders_windows() {
        let raw = ClaudeUsage {
            five_hour: Some(ClaudeWindow {
                utilization: Some(42.0),
                resets_at: Some("2026-07-08T12:00:00Z".into()),
            }),
            seven_day: Some(ClaudeWindow {
                utilization: Some(7.5),
                resets_at: None,
            }),
        };
        let info = neutral_usage(raw);
        assert_eq!(info.windows.len(), 2);
        assert_eq!(info.windows[0].label, "5-hour window");
        assert_eq!(info.windows[0].utilization, Some(42.0));
        assert_eq!(info.windows[1].label, "Weekly");
        assert_eq!(info.windows[1].resets_at, None);
    }

    #[test]
    fn neutral_usage_skips_absent_windows() {
        let info = neutral_usage(ClaudeUsage {
            five_hour: None,
            seven_day: Some(ClaudeWindow::default()),
        });
        assert_eq!(info.windows.len(), 1);
        assert_eq!(info.windows[0].label, "Weekly");
    }

    #[test]
    fn neutral_usage_of_nothing_is_an_empty_list() {
        assert!(neutral_usage(ClaudeUsage::default()).windows.is_empty());
    }
}
