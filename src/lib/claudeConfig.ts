// Pure parsing/summarizing for the Settings › Global Claude tab: turn the raw
// texts the `claude_config_overview` command returns into display rows. Kept
// out of the component so the branchy JSON handling is unit-testable
// (claudeConfig.test.ts) — malformed files must degrade to a labeled fallback,
// never a throw.

import { isPlainObject } from "./persist";

/** One summary chip for the settings.json section ("model: opus", "env (3)"). */
export interface SettingsChip {
  label: string;
  value?: string;
}

export interface SettingsSummary {
  chips: SettingsChip[];
  /** True when the file exists but isn't valid JSON (the edit affordance
   *  still opens — that's how the user fixes it). */
  invalid: boolean;
}

/** Summarize a raw settings.json text into chips. `null` (absent file) and
 *  `{}` both yield no chips; malformed JSON yields `invalid: true`. */
export function summarizeClaudeSettings(raw: string | null): SettingsSummary {
  if (raw == null || raw.trim() === "") return { chips: [], invalid: false };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { chips: [], invalid: true };
  }
  if (!isPlainObject(v)) return { chips: [], invalid: true };

  const chips: SettingsChip[] = [];
  if (typeof v.model === "string") chips.push({ label: "model", value: v.model });
  if (typeof v.outputStyle === "string")
    chips.push({ label: "output style", value: v.outputStyle });
  if (isPlainObject(v.permissions)) {
    const p = v.permissions;
    if (typeof p.defaultMode === "string")
      chips.push({ label: "permissions", value: p.defaultMode });
    if (Array.isArray(p.allow) && p.allow.length > 0)
      chips.push({ label: "allow rules", value: String(p.allow.length) });
    if (Array.isArray(p.deny) && p.deny.length > 0)
      chips.push({ label: "deny rules", value: String(p.deny.length) });
  }
  if (isPlainObject(v.env) && Object.keys(v.env).length > 0)
    chips.push({ label: "env", value: String(Object.keys(v.env).length) });
  if (isPlainObject(v.hooks) && Object.keys(v.hooks).length > 0)
    chips.push({ label: "hooks", value: Object.keys(v.hooks).join(", ") });
  if (isPlainObject(v.enabledPlugins) && Object.keys(v.enabledPlugins).length > 0)
    chips.push({ label: "plugins", value: String(Object.keys(v.enabledPlugins).length) });
  if (v.statusLine != null) chips.push({ label: "status line" });
  return { chips, invalid: false };
}

/** One user-scope MCP server row. */
export interface McpServerRow {
  name: string;
  /** The connection in one line: a URL for http/sse transports, the command
   *  line for stdio ones, or "—" when the entry is malformed. */
  detail: string;
}

/** Rows from the pretty-printed `mcpServers` object (`ClaudeOverview.mcp_servers`).
 *  `null`/malformed → empty (the section shows its empty state). */
export function listMcpServers(raw: string | null): McpServerRow[] {
  if (raw == null) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(v)) return [];
  return Object.entries(v).map(([name, cfg]) => {
    let detail = "—";
    if (isPlainObject(cfg)) {
      if (typeof cfg.url === "string") detail = cfg.url;
      else if (typeof cfg.command === "string")
        detail = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].join(" ");
    }
    return { name, detail };
  });
}
