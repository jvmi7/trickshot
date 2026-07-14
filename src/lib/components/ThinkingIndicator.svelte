<!-- DEPRECATED (GUI chat surface) — unreachable while CHAT_SURFACE === "cli"
     (stores.ts). Preserved for a possible GUI return; see CLAUDE.md ›
     "Deprecated GUI surface" before extending. -->
<script lang="ts">
  // Prop-driven primitive (Tier A): the shimmer "thinking" label + live elapsed
  // timer, shared by the main-chat loading footer (LoadingState) and the inline
  // thread panel (ThreadPanel) so both render an identical indicator. Takes props
  // and owns only its own ticker/typewriter — NO stores/api import. `humanTime` is
  // a pure formatter, not state.
  import { humanTime } from "../agentMessage";

  let { label, startedAt, steps = 0 }: { label: string; startedAt: number; steps?: number } =
    $props();

  // Tick the elapsed timer once a second while mounted.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const elapsed = $derived(Math.max(0, Math.floor((now - startedAt) / 1000)));
  const time = $derived(humanTime(elapsed));

  // The label animates two ways: a typewriter reveal (here, in JS) and a shimmer
  // sweep (CSS gradient clipped to the text — see app.css `.shimmer`). The $effect
  // re-runs whenever `label` changes (a new phrase), retyping it.
  let typed = $state("");
  $effect(() => {
    const target = label;
    typed = "";
    if (!target) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      typed = target.slice(0, i);
      if (i >= target.length) clearInterval(id);
    }, 22);
    return () => clearInterval(id);
  });
</script>

<div class="loading-state">
  <span class="loading-label"><span class="shimmer">{typed}</span></span>
  <span class="loading-meta"
    >{time}{#if steps > 0} · {steps} step{steps === 1 ? "" : "s"}{/if}</span
  >
</div>