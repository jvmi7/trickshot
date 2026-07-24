<script lang="ts">
  import * as Tabs from "$lib/components/ui/tabs";
  import SettingsAppearance from "./SettingsAppearance.svelte";
</script>

<div class="settings-page">
  <div class="settings-inner">
    <!-- Single tab for now — the Tabs wrapper stays as the mount point for
         future settings sections (e.g. a global Claude tab). -->
    <Tabs.Root value="appearance">
      <Tabs.List>
        <Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="appearance" class="pt-4">
        <SettingsAppearance />
      </Tabs.Content>
    </Tabs.Root>
  </div>
</div>
