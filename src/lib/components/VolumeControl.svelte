<script lang="ts">
  // Footer volume control: a speaker icon (click = mute toggle) + a compact
  // slider driving the SYSTEM output volume via the volume.rs commands. The
  // control probes once on mount and hides itself entirely when the probe
  // rejects (non-macOS, or an output device with no software volume) — the
  // footer stays clean rather than showing a dead slider. Drags are throttled
  // to one osascript spawn per ~80ms with a trailing set so the final thumb
  // position always lands. External changes (the keyboard volume keys) are
  // re-synced on hover. Feature component (calls api).
  import { spring } from "svelte/motion";
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

  // Hover grow on a REAL damped spring (svelte/motion — the slidingHighlight
  // precedent; framer-motion is React-only, this is the platform's own
  // spring physics). Slight overshoot on the way in reads as the "pop".
  const scale = spring(1, { stiffness: 0.2, damping: 0.5 });

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
    style="transform: scale({$scale})"
    onpointerenter={() => {
      scale.set(1.12);
      void sync();
    }}
    onpointerleave={() => scale.set(1)}
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
    /* Grows from its center on the hover spring (transform set inline). */
    transform-origin: center;
    will-change: transform;
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
  /* The slider reads as a minimal LINE: a full-radius track at 20% of the
     THEME TEXT color, and the FILL plays the knob — flush inside the track
     at 50%, rounded on the left, FLAT on the right so its leading edge
     marks the level. Anchored to --app-text, NOT currentColor: the control
     rests at --app-dim, and 50% of an already-dim gray vanished into the
     dark canvas — the line must read at rest, not only on hover. :global —
     the slot elements live inside ui/slider, which never gets hand-edited;
     the consumer restyles its own instance (the UsageIndicator badge
     precedent). 999px is the blessed pill radius. */
  .volume :global([data-slot="slider-track"]) {
    height: 4px;
    border-radius: 999px;
    background: color-mix(in oklch, var(--app-text) 20%, transparent);
  }
  .volume :global([data-slot="slider-range"]) {
    border-radius: 999px 0 0 999px;
    background: color-mix(in oklch, var(--app-text) 50%, transparent);
  }
  /* No visible knob — the fill's flat edge is the indicator. The thumb stays
     in the DOM for dragging + keyboard control and only surfaces for
     keyboard focus (the ring needs something to anchor to). */
  .volume :global([data-slot="slider-thumb"]) {
    opacity: 0;
  }
  .volume :global([data-slot="slider-thumb"]:focus-visible) {
    opacity: 1;
  }
</style>
