<script lang="ts">
  import * as Tabs from "$lib/components/ui/tabs";
  import SettingsAppearance from "./SettingsAppearance.svelte";
  import SettingsGlobalClaude from "./SettingsGlobalClaude.svelte";
</script>

<div class="settings-page">
  <div class="settings-inner">
    <Tabs.Root value="appearance">
      <Tabs.List>
        <Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
        <Tabs.Trigger value="claude">Global Claude</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="appearance" class="pt-4">
        <SettingsAppearance />
      </Tabs.Content>

      <Tabs.Content value="claude" class="pt-4">
        <SettingsGlobalClaude />
      </Tabs.Content>
    </Tabs.Root>
  </div>
</div>
