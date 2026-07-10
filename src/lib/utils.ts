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
