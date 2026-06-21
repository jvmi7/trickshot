import { writable } from "svelte/store";
import type { SDKMessageLike, Worktree } from "./types";

export interface PermissionReq {
  id: string;
  tool: string;
  input: unknown;
}

/** The selected git repository (absolute path). */
export const repoPath = writable<string | null>(null);

/** Worktrees of the selected repo. */
export const worktrees = writable<Worktree[]>([]);

/** The cwd of the currently running agent session (a repo or worktree path). */
export const activeProjectDir = writable<string | null>(null);

/** Whether a sidecar session is currently running. */
export const sessionActive = writable<boolean>(false);

/** The conversation transcript for the active session. */
export const messages = writable<SDKMessageLike[]>([]);

/** A pending tool-permission request awaiting the user's decision (or null). */
export const pendingPermission = writable<PermissionReq | null>(null);
