import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class names with Tailwind-aware conflict resolution (shadcn convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Last path segment of a filesystem path — handles both `/` and `\` separators
 *  and trailing separators. The ONE basename helper (sidebar repo labels,
 *  notification names, tool-call file labels all route through here). */
export function basename(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}

/** Stable per-workspace identity hue (0–359) hashed from the worktree path —
 *  every workspace gets its own color so parallel agents are visually
 *  tellable-apart (terminal tint, header prompt, sidebar chips). */
export function workspaceHue(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Coarse relative time for list metadata ("just now", "5m ago", "3h ago",
 *  "2d ago", then a short date). `now` is injectable for tests. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Chromeless Select.Trigger recipe for the composer's inline pickers
 *  (ModelSelector, PermissionModeSelector): muted ghost trigger — no border,
 *  bg, shadow, or focus ring; subtle hover tint. One string so the two
 *  triggers can't drift. */
export const ghostSelectTrigger =
  "text-muted-foreground h-9 gap-1 border-0 bg-transparent shadow-none focus-visible:ring-0 data-[size=sm]:h-9 dark:bg-transparent dark:hover:bg-input/40";

// Type helpers used by shadcn-svelte primitives in $lib/components/ui.
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
