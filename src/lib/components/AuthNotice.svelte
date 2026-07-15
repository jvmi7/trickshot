<script lang="ts">
  // Ambient "sign in" notice — the ONE home for the auth banner (Chat's composer
  // banner and Welcome's first-run notice both render this). Feature component:
  // reads `authState` + the active provider's copy (providers.ts) and retries via
  // refreshAuth. Renders nothing unless the login is definitively missing.
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils";
  import { providerDisplay } from "../providers";
  import { activeProvider, authState, refreshAuth } from "../stores";

  let { class: className = "" }: { class?: string } = $props();
  const notice = $derived(providerDisplay($activeProvider).signInNotice);
</script>

{#if $authState === "missing"}
  <div
    class={cn(
      "bg-destructive/10 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-xs",
      className,
    )}
  >
    <TriangleAlert class="size-3.5 shrink-0" />
    <span>
      {notice.before}{#if notice.command}<code>{notice.command}</code>{/if}{notice.after ?? ""}
    </span>
    <Button
      variant="ghost"
      size="xs"
      class="text-destructive hover:text-destructive ml-auto shrink-0 gap-1"
      onclick={() => void refreshAuth()}
    >
      <RotateCw class="size-3" /> retry
    </Button>
  </div>
{/if}

<style>
  code {
    background: var(--app-code-bg);
    border-radius: var(--radius-2xs);
    padding: 1px 5px;
    font-size: var(--text-xs);
  }
</style>
