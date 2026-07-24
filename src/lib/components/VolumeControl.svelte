<script lang="ts">
  // Footer volume control: a speaker icon (click = mute toggle) + a compact
  // slider driving the SYSTEM output volume via the volume.rs commands. The
  // control probes once on mount and hides itself entirely when the probe
  // rejects (non-macOS, or an output device with no software volume) — the
  // footer stays clean rather than showing a dead slider. Drags are throttled
  // to one osascript spawn per ~80ms with a trailing set so the final thumb
  // position always lands. External changes (the keyboard volume keys) are
  // re-synced on hover. Feature component (calls api).
  import * as api from "../api";
  import { Slider } from "$lib/components/ui/slider";
  import Volume2 from "@lucide/svelte/icons/volume-2";
  import Volume1 from "@lucide/svelte/icons/volume-1";
  import VolumeX from "@lucide/svelte/icons/volume-x";

  let available = $state(false);
  let volume = $state(0);
  let muted = $state(false);

  const SET_THROTTLE_MS = 80;
  let setTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSet: number | null = null;

  const Icon = $derived(muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2);

  async function sync() {
    try {
      const info = await api.getVolume();
      volume = info.volume;
      muted = info.muted;
      available = true;
    } catch {
      available = false;
    }
  }

  $effect(() => {
    void sync();
    return () => {
      if (setTimer) clearTimeout(setTimer);
    };
  });

  /** Throttled system set: apply at most one osascript per window, with a
   *  trailing call so the release position always lands. */
  function pushVolume(v: number) {
    volume = v; // the UI tracks the thumb immediately
    muted = false; // set_volume unmutes in Rust; mirror it
    if (setTimer) {
      pendingSet = v;
      return;
    }
    void api.setVolume(v).catch(() => (available = false));
    setTimer = setTimeout(() => {
      setTimer = null;
      if (pendingSet != null) {
        const trailing = pendingSet;
        pendingSet = null;
        void api.setVolume(trailing).catch(() => (available = false));
      }
    }, SET_THROTTLE_MS);
  }

  function toggleMute() {
    muted = !muted;
    void api.setMuted(muted).catch(() => (available = false));
  }
</script>

{#if available}
  <div
    class="volume"
    onpointerenter={() => void sync()}
    title="System output volume"
    role="group"
    aria-label="System volume"
  >
    <button
      type="button"
      class="volume-icon"
      aria-label={muted ? "Unmute" : "Mute"}
      onclick={toggleMute}
    >
      <Icon class="size-3.5" />
    </button>
    <Slider
      type="single"
      value={volume}
      onValueChange={(v: number) => pushVolume(v)}
      min={0}
      max={100}
      step={1}
      class="volume-slider w-20"
      aria-label="System output volume"
    />
  </div>
{/if}

<style>
  /* Footer-scale chrome (split-by-reach): dim by default, wakes on hover
     like the neighboring footer items. */
  .volume {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--app-dim);
    transition: color var(--app-duration-fast);
  }
  .volume:hover {
    color: var(--app-text);
  }
  .volume-icon {
    display: inline-flex;
    align-items: center;
    padding: 2px;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
</style>
