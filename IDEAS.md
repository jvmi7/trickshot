# Ideas

Scratchpad for features and polish we might build. Not a roadmap, not a promise —
move an item to an issue/PR when it becomes real, delete it when it stops being
interesting. One `##` section per area; add a line under **Parked** with a reason
instead of silently deleting something we consciously decided against.

## Chat / tabs

- Keyboard shortcuts for chats: ⌘1–9 to switch tabs, ⌘T new chat, ⌘W close chat.
- Rename a chat tab (double-click the label) — "Chat 2" tells you nothing once
  you have three long-running sessions.
- Drag-to-reorder tabs (the sliding chrome already animates position — reuse it).
- Broadcast mode: send one prompt to every chat in the worktree at once
  (compare answers, or fan a task out).
- Session picker on open: choose which past `.jsonl` session to resume instead of
  always the newest (`latest_session_id` already scans the store).

## Terminal backdrop

- Machi market fish swimming in the terminal background while Claude is working
  on a response (imran's — implementing later). The shared chat-trail canvas
  behind the terminal (`cursorTrail.ts` / `.chat-trail`) is the natural home: it
  already paints per-frame behind the transparent xterm, and `cliActivity.ts`'s
  busy state is the swim/idle trigger. Keep it on that one canvas so it stays on
  the PTY hot path's good side (no per-chunk work, pause the loop when idle).

## Grid layout

- Click-to-zoom a grid cell to focused view and back (grid ⇄ tabs without the
  header toggle).
- Drag the grid's internal dividers to resize cells.

## Fleet / sidebar

- Fleet overview shows per-chat status dots (it currently aggregates to one
  worktree-level status).
- Per-chat unread, not just per-worktree.

## Usage / status

- Model indicator in the usage chip — attempted once and reverted (detection was
  unreliable on fresh sessions); revisit if the CLI ever exposes current model in
  a probe-able way.

## Git / review

- Inline "re-request review" that re-sends only the diff hunks that changed since
  the last review-queue prompt.

## Parked

- Notification system (OS notify + in-app bell) — deleted deliberately; unread
  badges + busy dots are the signal. Don't reintroduce.
- Auto-respawn on CLI exit — fork-bombs on a crash-looping CLI; typing revives
  the session instead.
