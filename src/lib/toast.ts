// Toast facade — the ONE home for raising toasts (receipts, undo offers,
// header-overflow errors). svelte-sonner is loaded LAZILY at call time: the
// store layer (session.ts et al) is imported by bun tests, where a module-eval
// dependency on a UI library both couples plain TS to the DOM and trips bun's
// resolver on svelte-sonner's nested `runed`. The dynamic import is
// failure-tolerant — in an environment with no toaster it silently no-ops.

interface ToastAction {
  label: string;
  onClick: () => void;
}

function withSonner(fn: (t: typeof import("svelte-sonner").toast) => void): void {
  import("svelte-sonner").then((m) => fn(m.toast)).catch(() => {});
}

/** Neutral toast, optionally with an action button (e.g. "Undo"). */
export function toastMessage(message: string, opts?: { action?: ToastAction }): void {
  withSonner((t) => t(message, opts));
}

/** Success receipt (e.g. "Sent to the agent"). */
export function toastSuccess(message: string): void {
  withSonner((t) => t.success(message));
}

/** Error surface for controls too small to show the full text inline. */
export function toastError(message: string): void {
  withSonner((t) => t.error(message));
}
