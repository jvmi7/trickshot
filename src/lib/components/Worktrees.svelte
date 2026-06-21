<script lang="ts">
  import { repoPath, worktrees, activeProjectDir, sessionActive, messages } from "../stores";
  import * as api from "../api";

  let branch = "";
  let manualPath = "";
  let busy = false;
  let error = "";

  async function pickRepo() {
    error = "";
    try {
      const p = await api.pickDirectory();
      if (p) {
        repoPath.set(p);
        await refresh();
      }
    } catch (e) {
      error = String(e);
    }
  }

  function useManual() {
    const p = manualPath.trim();
    if (p) {
      repoPath.set(p);
      refresh();
    }
  }

  async function refresh() {
    const rp = $repoPath;
    if (!rp) return;
    try {
      worktrees.set(await api.listWorktrees(rp));
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  // One click: create a new worktree (+ branch) and immediately start a session in it.
  async function createAndLaunch() {
    const rp = $repoPath;
    if (!rp || !branch.trim()) return;
    busy = true;
    error = "";
    try {
      const wt = await api.createWorktree(rp, branch.trim());
      worktrees.update((w) => [...w, wt]);
      branch = "";
      await launch(wt.path);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function launch(dir: string) {
    error = "";
    try {
      await api.startAgent(dir);
      activeProjectDir.set(dir);
      sessionActive.set(true);
      messages.set([]);
    } catch (e) {
      error = String(e);
    }
  }

  async function remove(path: string) {
    const rp = $repoPath;
    if (!rp) return;
    error = "";
    try {
      await api.removeWorktree(rp, path, true);
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
</script>

<div class="wt">
  <h2>Repository</h2>
  {#if $repoPath}
    <div class="repo" title={$repoPath}>{$repoPath}</div>
    <div class="row">
      <button on:click={refresh}>Refresh</button>
      <button on:click={() => { if ($repoPath) launch($repoPath); }}>Start in main repo</button>
    </div>
  {:else}
    <button class="primary block" on:click={pickRepo}>Choose folder…</button>
    <div class="manual">
      <input placeholder="/path/to/repo" bind:value={manualPath} on:keydown={(e) => e.key === "Enter" && useManual()} />
      <button on:click={useManual}>Use</button>
    </div>
  {/if}

  {#if $repoPath}
    <h2>New worktree</h2>
    <div class="create">
      <input
        placeholder="branch name (e.g. feature/login)"
        bind:value={branch}
        on:keydown={(e) => e.key === "Enter" && createAndLaunch()}
      />
      <button class="primary" disabled={busy || !branch.trim()} on:click={createAndLaunch}>
        Create + Start
      </button>
    </div>

    <h2>Worktrees</h2>
    <ul class="list">
      {#each $worktrees as w (w.path)}
        <li class:active={$activeProjectDir === w.path}>
          <div class="wt-branch">{w.branch ?? "(detached)"}{w.is_main ? " · main" : ""}</div>
          <div class="wt-path" title={w.path}>{w.path}</div>
          <div class="row">
            <button on:click={() => launch(w.path)}>Start</button>
            {#if !w.is_main}
              <button on:click={() => remove(w.path)}>Remove</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if error}
    <div class="error-box">{error}</div>
  {/if}
</div>
