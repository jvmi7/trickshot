<script lang="ts">
  // Per-worktree tool-permission mode picker for the composer. Switching is a
  // streaming-mode control request, so it's only enabled while the session is
  // live. The choice is persisted (sticky across restarts) and applied live via
  // set_permission_mode. `bypassPermissions` (the default) runs tools silently;
  // the others route tool use through the Allow/Deny modal.
  import * as Select from "$lib/components/ui/select";
  import * as api from "../api";
  import {
    activePermissionMode,
    selectedWorktree,
    sessionStatus,
    setWorktreePermissionMode,
    PERMISSION_MODES,
  } from "../stores";
  import type { PermissionMode } from "../types";

  const MODE_LABELS: Record<PermissionMode, string> = {
    bypassPermissions: "Auto-run",
    acceptEdits: "Accept edits",
    default: "Ask each",
    plan: "Plan",
  };

  const status = $derived($selectedWorktree ? $sessionStatus[$selectedWorktree] : undefined);
  const alive = $derived(status === "ready" || status === "busy");
  const disabled = $derived(!$selectedWorktree || !alive);
  const label = $derived(MODE_LABELS[$activePermissionMode]);

  function choose(value: string | undefined) {
    const wt = $selectedWorktree;
    if (!wt || !value || value === $activePermissionMode) return;
    const mode = value as PermissionMode;
    setWorktreePermissionMode(wt, mode);
    api.setPermissionMode(wt, mode);
  }
</script>

<Select.Root type="single" value={$activePermissionMode} onValueChange={choose} {disabled}>
  <Select.Trigger
    size="sm"
    class="text-muted-foreground h-9 gap-1 border-0 bg-transparent shadow-none focus-visible:ring-0 data-[size=sm]:h-9 dark:bg-transparent dark:hover:bg-input/40"
    aria-label="Permission mode for this chat"
  >
    {label}
  </Select.Trigger>
  <Select.Content>
    {#each PERMISSION_MODES as mode (mode)}
      <Select.Item value={mode} label={MODE_LABELS[mode]}>
        <span class="truncate">{MODE_LABELS[mode]}</span>
      </Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
