// Persistence primitives — the localStorage-backed store template split out of
// stores.ts (the transcript.ts precedent: a self-contained subsystem whose
// invariants live in one file). This is the CANONICAL home of "the ONE template"
// every persisted `trickshot.*` store is built from (see CLAUDE.md): a load()
// with a shape guard + fallback, then a subscribe() write-back that swallows
// quota errors. A leaf module — it must never import from stores.ts or its
// sibling store modules.

import { type Writable, writable } from "svelte/store";

const hasLS = typeof localStorage !== "undefined";

// ---- Persistence primitive (the ONE template) ----
// A localStorage-backed writable: load() with a shape guard + fallback, then a
// subscribe() write-back that swallows quota errors, under a `trickshot.<name>`
// key. Every persisted store is built from this — the guard/quota invariant
// is structural here instead of hand-copied per store (see CLAUDE.md). `parse`
// turns the stored string into T and MAY throw or return the fallback for bad
// data (load() catches and falls back); `serialize` defaults to JSON.
export function createPersisted<T>(
  key: string,
  fallback: T,
  opts: { parse?: (raw: string) => T; serialize?: (value: T) => string } = {},
): Writable<T> {
  const serialize = opts.serialize ?? ((v: T) => JSON.stringify(v));
  const parse = opts.parse ?? ((raw: string) => JSON.parse(raw) as T);
  const load = (): T => {
    if (!hasLS) return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    try {
      return parse(raw);
    } catch {
      return fallback;
    }
  };
  const store = writable<T>(load());
  store.subscribe((v) => {
    if (!hasLS) return;
    try {
      localStorage.setItem(key, serialize(v));
    } catch {
      /* ignore quota errors */
    }
  });
  return store;
}

/** A persisted store of a raw string (identity parse/serialize) — the JSON
 *  helpers' string counterpart. Optional `validate` clamps a stored value to a
 *  known set (e.g. theme/font ids), falling back when it doesn't match. */
export function createPersistedString(
  key: string,
  fallback = "",
  validate?: (raw: string) => string,
): Writable<string> {
  return createPersisted<string>(key, fallback, {
    parse: validate ?? ((raw) => raw),
    serialize: (v) => v,
  });
}

/** The shape guard shared by every "is this a plain JSON object?" check
 *  (object, not null, not array). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** `createPersisted` parse fn for "a JSON object map of V" with the standard
 *  shape guard. Anything else → the empty map. */
export function parseJsonObject<V>(raw: string): Record<string, V> {
  const v = JSON.parse(raw);
  return isPlainObject(v) ? (v as Record<string, V>) : {};
}
