<script lang="ts">
  // Connectors (MCP servers) are managed by Claude Code itself — the CLI reads
  // `claude mcp` config and the project's `.mcp.json` directly, so the app has
  // no live catalog to show. This tab is the signpost.
</script>
<div class="mb-2 flex items-baseline justify-between">
  <span class="text-sm text-muted-foreground">
    Connectors this instance can use — changes apply to every repo.
  </span>
</div>

<p class="py-3 text-sm text-muted-foreground">
  Manage connectors with
  <code>claude mcp</code> (or your project's <code>.mcp.json</code>); the CLI picks them up
  directly.
</p>
