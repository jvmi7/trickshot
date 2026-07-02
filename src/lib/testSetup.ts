// bun test preload (wired in bunfig.toml): a Map-backed localStorage so the
// persistence template (stores.ts › createPersisted, transcript.ts) sees real
// storage in unit tests — bun has no DOM. It MUST install before any module
// loads, because both modules snapshot `typeof localStorage` at module eval.
// Storage-typed via the one confined cast below (the stub implements the
// subset the app uses; Storage's index signature can't be met by a class).

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

if (typeof localStorage === "undefined") {
  // WHY the cast: Storage declares a string index signature a TS class can't satisfy.
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
}
