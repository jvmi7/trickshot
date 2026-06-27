<script lang="ts">
  import * as Tabs from "$lib/components/ui/tabs";
  import SettingsAppearance from "./SettingsAppearance.svelte";
  import SettingsConnectors from "./SettingsConnectors.svelte";
</script>

<div class="settings-page">
  <div class="settings-inner">
    <Tabs.Root value="appearance">
      <Tabs.List>
        <Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
        <Tabs.Trigger value="connectors">Connectors</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="appearance" class="pt-4">
        <SettingsAppearance />
      </Tabs.Content>

      <Tabs.Content value="connectors" class="pt-4">
        <SettingsConnectors />
      </Tabs.Content>
    </Tabs.Root>
  </div>
</div>
