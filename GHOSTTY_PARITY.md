# Ghostty parity — gap analysis & roadmap

Target: bring trickshot's terminal experience to feature parity with **Ghostty 1.3.1** (March 2026, the
current release) for macOS users. This document is the research deliverable: what Ghostty has, what we
have, what the gap is, and in what order to close it.

**Scoping reality up front.** Ghostty is a native Swift/Zig app with its own VT emulator and Metal
renderer. Trickshot is a Tauri webview embedding **xterm.js 6.0** over a Rust `portable-pty`. Parity
therefore means: *match the terminal experience* (emulation fidelity, interaction, speed, config
surface) — not the native chrome (Metal, AppleScript, native tabs, libghostty). Items that are
architecturally out of reach are marked so, honestly, rather than hand-waved.

Also load-bearing: trickshot's chat pane IS a terminal (the Claude Code TUI on the claude-slot PTY),
so emulator-quality gaps hit the app's primary surface, not just the shell popover.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Already at parity (or better) |
| 🟡 | Partial — exists but narrower than Ghostty |
| ❌ | Missing, **feasible** in xterm.js / Tauri |
| 🚫 | Out of reach without upstream xterm.js work or a native rewrite |
| ⛔ | Deliberately excluded by an app decision (do not build) |

## Where trickshot stands today (inventory)

The current terminal is deliberately thin:

- xterm.js **6.0.0** with **`@xterm/addon-fit` as the only addon** (`package.json`, `terminal.ts:152`).
  DOM renderer (no WebGL/canvas addon).
- Constructor options: `fontSize` (store, 11–16px), `fontFamily` **hardcoded**
  `ui-monospace, Menlo, monospace`, `cursorBlink: true`, `scrollback: 5000`,
  `allowTransparency: true`, per-workspace ANSI theme (`terminal.ts:142-151`). Nothing else set.
- Rust PTY: `$SHELL -l` (shell slot) / resolved `claude` binary (claude slot), `TERM=xterm-256color`,
  **no `COLORTERM`/`TERM_PROGRAM`**, `PtySize.pixel_width/height` **always 0** (`terminal.rs:128-135, 244-246`).
  UTF-8-boundary-safe 8KiB relay, zero per-chunk transform.
- Two PTYs max per worktree (shell + claude slots), cached xterm instances that survive worktree
  switches, busy/unread heuristics (`cliActivity.ts`), bracketed-paste compose (⌘E), careful
  debounced fit/resize with a veil.
- User-facing terminal settings: theme (5), UI font (not terminal font), terminal font size,
  uniform type. That's all.
- **No**: search, clickable links/OSC 8, OSC 52, images, ligatures, unicode-width addon, copy-on-select,
  context menu, paste protection, font-zoom keys, tabs/splits, shell integration (OSC 133/7),
  cursor-style config, `macOptionIsMeta`, scrollback setting, drag-drop paths, opacity/blur.

Genuine strengths to keep (some *exceed* Ghostty): per-workspace ANSI identity palettes; PTYs stay
alive across worktree switches with instant re-attach; Claude-session resume across app restarts
(Ghostty's `window-save-state` restores layout, **not** running processes); cursor-trail effect without
custom shaders; the compose editor.

---

## Gap analysis by category

### 1. Rendering & fonts

| Feature (Ghostty) | Trickshot today | Status / path |
|---|---|---|
| GPU renderer (Metal) | DOM renderer | ❌ **`@xterm/addon-webgl`** is our ceiling and the single biggest perf lever for TUI repaints. Must verify interplay with `allowTransparency` + the backdrop/cursor-trail layers, and keep a DOM fallback on context loss. |
| Font shaping & ligatures (HarfBuzz/CoreText) | None (per-cell DOM spans) | 🟡 `@xterm/addon-ligatures` needs Node `fs` (won't run in a webview). Realistic path: bundle a ligature-light coding font and accept no cross-cell shaping; treat full shaping as 🚫. |
| Embedded fonts (JetBrains Mono + Nerd Font symbols, zero-config) | Hardcoded `ui-monospace, Menlo, monospace` | ❌ Ship JetBrains Mono + a Nerd Font symbols fallback via `@font-face`, put them in the default `fontFamily` stack. Closes the "Powerline glyphs look broken" class of complaints. |
| Font family / per-style / features / variable axes config | None | 🟡 Add a **terminal font-family setting** (curated list + custom string). Per-style families & `font-feature` are niche — defer. |
| Font fallback | Browser/CSS fallback | ✅ (webview gives us system fallback for free) |
| Box-drawing/Powerline pixel-perfect custom glyphs | Font-rendered | 🚫 xterm.js has partial built-in box-drawing (`customGlyphs: true` — enable it); Ghostty's full sprite set (octants, legacy computing) is upstream territory. |
| Emoji & grapheme clusters (Unicode 17, mode 2027) | xterm 6 defaults | ❌ Add `@xterm/addon-unicode-graphemes` (or `-unicode11`) and activate the provider — fixes emoji/CJK width bugs in the Claude TUI today. |
| Minimum contrast (`minimum-contrast`) | Not set | ❌ `minimumContrastRatio` constructor option — trivial. |
| Cursor style/blink/color config (`cursor-style`, DECSCUSR) | `cursorBlink: true` only | ❌ Expose cursor style + blink in Settings; xterm supports `cursorStyle`, `cursorInactiveStyle`; DECSCUSR handled by core. |
| Custom GLSL shaders (cursor trails etc.) | `cursorTrail.ts` canvas effect | ⛔/✅ No shader hook exists in xterm-webgl; our cursor trail is the in-house equivalent. Don't chase this. |
| Window opacity + blur (`background-opacity`, `background-blur`, liquid glass) | Opaque window | ❌ Tauri 2 `windowEffects` (macOS vibrancy) + transparent theme background. Medium effort; interacts with the theme system — design pass needed. |
| Background images | None | ❌ Feasible (CSS layer under xterm's transparent bg) but low value — defer. |
| Unfocused split dimming | n/a (no splits) | See splits (§3). |
| Underline styles/colors (undercurl, SGR 4:x, 58/59) | xterm.js core support | 🟡 Core supports styled/colored underlines; verify rendering on the renderer we ship (best under WebGL). |
| Metric overrides (`adjust-*`) | None | Defer — niche. `lineHeight`/`letterSpacing` options exist if ever needed. |

### 2. Terminal emulation / VT protocol

| Feature (Ghostty) | Trickshot today | Status / path |
|---|---|---|
| Truecolor + 256 + ANSI16 | ✅ xterm.js core | ✅ — but we never advertise it: **set `COLORTERM=truecolor`**, `TERM_PROGRAM=trickshot`, `TERM_PROGRAM_VERSION` in `terminal.rs`. ❌ trivial, high value (CLIs key colors off this). |
| `TERM=xterm-ghostty` + shipped terminfo | `TERM=xterm-256color` | ✅ Deliberate: stay `xterm-256color` (maximally compatible, honest about capabilities). No custom terminfo. |
| Kitty graphics protocol | None | 🚫 No maintained xterm.js addon; Ghostty-only path. |
| Sixel / iTerm inline images | None | ❌ `@xterm/addon-image` (sixel + iTerm IIP). Ghostty *rejects* sixel, so this is parity-adjacent bonus. Requires fixing **`pixel_width/height = 0`** in `terminal.rs` (send cell-pixel dims on open/resize) — that fix also unlocks correct `CSI 14/16 t` reports. |
| Kitty keyboard protocol / modifyOtherKeys / CSI u | None | 🚫 Not in xterm.js; upstream issue. Affects power-TUIs (neovim), not the Claude TUI. Document as known gap. |
| Bracketed paste (2004) | ✅ core (+ compose uses it) | ✅ |
| Focus reporting (1004) | ✅ core | ✅ |
| Mouse reporting (9/1000/1002/1003, SGR 1006/1016) | ✅ core | ✅ (xterm.js covers the modes that matter) |
| Synchronized output (2026) | Unverified | 🟡 Believed handled by xterm.js core ≥5.x — verify with a test app; if absent it's upstream. |
| Grapheme clustering (2027) | None | 🟡 Addon improves behavior; mode *reporting* may still differ — acceptable. |
| Color-scheme reporting (2031) + OSC color set/query | Unverified | 🟡 Verify xterm.js OSC 4/10/11 query handling; 2031 push-notify likely needs a small custom handler (`registerCsiHandler`) when the app theme flips. |
| In-band size reports (2048) | None | 🚫/defer — niche, upstream. |
| OSC 8 hyperlinks | **None** | ❌ Core handles OSC 8 — provide a `linkHandler` that opens via Tauri opener with a confirm/hover UI. |
| OSC 52 clipboard | None | ❌ `@xterm/addon-clipboard`; gate reads (Ghostty: ask/allow/deny). Claude Code + tmux users hit this. |
| OSC 133 semantic prompts | None | ❌ Custom `registerOscHandler(133)` + xterm markers → jump-to-prompt, select-command-output. Depends on shell integration (§4). |
| OSC 7 cwd reporting | None | ❌ Custom handler; powers "new shell inherits cwd" + cwd display. |
| OSC 9 / 777 notifications, OSC 9;4 progress | None | ⛔ The notification system was deliberately deleted (CLAUDE.md) — do not rebuild. If ever revisited, a silent Fleet progress indicator is the only tasteful subset. |
| XTGETTCAP, DECRQM, XTWINOPS | Partial (core) | 🟡 Core answers some; correct `CSI 14/16 t` needs the pixel-size fix above. |
| DECSLRM (left/right margins), rectangular VT ops | None | 🚫 Not in xterm.js (Ghostty lacks rectangular ops too). |
| Fuzzed parser robustness | n/a | ✅ Inherited from xterm.js (widely fuzzed upstream). |

### 3. App features (Ghostty's macOS chrome, translated to trickshot)

| Feature (Ghostty) | Trickshot today | Status / path |
|---|---|---|
| Splits (create/navigate/resize/zoom/equalize, dimming, drag-reorder) | None — exactly 1 shell + 1 claude per worktree | ❌ **Largest single work item.** Multiple shell PTYs per worktree: extend the slot key scheme (`wt + " shell:<n>"` beside `CLAUDE_SLOT`), Rust already handles concurrent PTYs; add split/tab UI in the shell surface. Worktrees already play the "tabs" role at the app level — recommend **splits + tabs inside the shell pane only**, keeping the one-chat-per-worktree model. |
| Native macOS tabs | Worktree sidebar + ⌘1-9 | ✅ Different idiom, same job (plus Fleet overview). Not a gap to close literally. |
| Quick Terminal (global dropdown) | None | ❌ Tauri global-shortcut plugin + summon window with the active worktree's shell. Medium; nice-to-have. |
| Command palette | ⌘K palette exists | 🟡 Ours covers app actions; add terminal actions (search, clear, font size, new split…) as they land. |
| Scrollback search (⌘F, added 1.3) | **None** | ❌ `@xterm/addon-search` + find bar UI (all-match highlight, ⌘G/⇧⌘G). High value — Ghostty users just got this and notice it. |
| Native scrollbars (1.3) | Scrollbar hidden by design | 🟡 Deliberate for the TUI pane (mouse-captured); consider an overlay scrollbar for the shell pane only. |
| Undo close (⌘Z restores closed surface) | Worktree archive/restore | 🟡 App-level equivalent exists; per-split undo arrives with splits. |
| Window state save/restore | Workspace + Claude session resume | ✅ (stronger where it counts — the conversation survives) |
| Secure keyboard entry (auto + manual) | None | ❌ `EnableSecureEventInput` via `objc2` in Rust; small, niche — defer. |
| Drag & drop files → shell-escaped path | None | ❌ Tauri drag-drop event → quoted path via bracketed paste. Small, satisfying. |
| Fullscreen, opacity toggle, float-on-top, dock menu, proxy icon, Quick Look, Services, AppleScript, Shortcuts, VoiceOver, localization | Standard Tauri window | 🚫/⛔ Native-app surface. Disproportionate for a webview app; skip knowingly. |
| Auto-update (Sparkle) | None | ❌ `tauri-plugin-updater` — parity-equivalent mechanism. App-infra, not terminal work. |
| Bell (dock bounce/badge, sounds) | None | ⛔ Same deleted-notifications decision. Unread badges are the app's signal. |
| Custom app icons | Fixed icon | Defer — cosmetic. |
| Read-only mode, tab colors, title prompts | None | Defer — niche. |

### 4. Shell integration

Ghostty auto-injects for zsh/bash/fish/elvish/nu and gets: prompt marks (jump/select output),
cwd reporting, title, bar-cursor at prompt, sudo terminfo wrap, ssh env/terminfo forwarding,
click-to-move-cursor, command-finished notifications.

Trickshot has **none** of this. Path (❌, medium):

1. Ship `zsh`/`bash`/`fish` integration scripts emitting **OSC 133 + OSC 7** (the VS Code/Ghostty
   pattern); inject via `ZDOTDIR` shim for the shell slot only (never the claude slot — the TUI owns
   that surface).
2. Webview: OSC 133 handler + markers → **jump-to-prompt keybinds** and **select-command-output**;
   OSC 7 → cwd chip + "new split inherits cwd".
3. Skip: sudo wrap (we're `xterm-256color` — nothing to break), ssh-terminfo (ditto),
   command-finished notify (⛔ deleted), click-to-move-cursor (needs 133 `cl=line`; defer).

### 5. Text & interaction

| Feature (Ghostty) | Trickshot today | Status / path |
|---|---|---|
| Clickable URLs (`link-url`, hover, previews) | None | ❌ `@xterm/addon-web-links` (regex) + OSC 8 `linkHandler`; open via Tauri opener; cmd+click gesture to match Ghostty. |
| Copy-on-select (default ON, macOS) | None | ❌ `onSelectionChange` → clipboard write, behind a setting (default on to match). |
| Right-click menu / `right-click-action` | None | ❌ Small context menu: Copy / Paste / Select All / Clear / Copy URL. |
| Paste protection (unsafe paste confirm) | None | ❌ Intercept paste; warn on newlines/control chars outside bracketed mode. Security-relevant (Ghostty shipped a CVE fix here). |
| Selection: word/line/keyboard-adjust | xterm defaults (double/triple-click) | 🟡 Defaults cover word/line; keyboard selection adjust is upstream-bound — defer. |
| Rectangular selection | None | 🚫 Not supported by xterm.js. |
| Font zoom keys (⌘+/⌘−/⌘0) | Settings dropdown only | ❌ Wire keybinds to the existing `applyTerminalFontSize`. Trivial. |
| Select All / Clear / scroll-to-top/bottom / page keys | None | ❌ ⌘A, ⌘Home/End (etc.) for the shell pane; careful not to shadow the TUI pane. |
| Scrollback limit config | Fixed 5000 lines | ❌ Settings entry (lines; Ghostty is byte-based — lines are fine for us). |
| Rich clipboard (HTML/VT copy) | Plain text | Defer — niche. |
| `write_screen_file`, screen dumps | None | Defer. `@xterm/addon-serialize` would also enable scrollback persistence across restarts — worth noting, Ghostty doesn't have that either. |
| Mouse-hide-while-typing, scroll multiplier | None | Defer — polish tier. |

### 6. Config & theming

| Feature (Ghostty) | Trickshot today | Status / path |
|---|---|---|
| Hundreds of bundled themes (iTerm2 schemes) | 5 app themes + per-workspace ANSI identity | 🟡 Different philosophy: our workspace-identity palettes are a feature, not a gap. Worth adding: a **terminal color scheme picker** (import the iTerm2-Color-Schemes set as ANSI-16 palettes) that can override the identity palette per worktree. Design decision required. |
| Light/dark auto-switch (`theme = dark:X,light:Y`) | Manual theme pick | ❌ Tauri theme-change event → auto-switch between a chosen light/dark theme pair. We already have `paper` as the light theme. |
| Live config reload | Settings apply live | ✅ |
| Keybind customization (sequences, key tables, global:) | Fixed shortcuts | 🟡 A minimal rebind UI for our ~10 shortcuts is feasible; Ghostty's full trigger grammar is out of scope. Defer. |
| CLI actions (+list-themes etc.) | n/a | ⛔ Not applicable to a GUI app. |
| `env` config (extra PTY env vars) | None | ❌ Easy addition to `.trickshot/settings.json` if asked; defer until asked. |

---

## Roadmap (proposed order)

Each phase is a shippable PR-sized chunk; P0/P1 are where near-all of the daily-felt gap lives.

**P0 — emulator core quality (one PR each, all small):**
1. `@xterm/addon-webgl` with DOM fallback + transparency verification.
2. `@xterm/addon-search` + ⌘F find bar (shell **and** claude panes).
3. Links: `@xterm/addon-web-links` + OSC 8 `linkHandler` (cmd+click, Tauri opener).
4. Unicode: `@xterm/addon-unicode-graphemes` active.
5. Env: `COLORTERM=truecolor`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`; PTY pixel dims on open/resize.
6. Options: `minimumContrastRatio`, `customGlyphs`, `macOptionIsMeta` (setting), cursor style/blink settings, scrollback-size setting.

**P1 — interaction parity:**
7. Copy-on-select (default on) + right-click menu + paste protection.
8. Font-zoom keybinds (⌘+/⌘−/⌘0) + shell-pane keys (⌘A select-all, scroll keys, clear).
9. Terminal font-family setting + bundled JetBrains Mono & Nerd Font symbols fallback.
10. `@xterm/addon-clipboard` (OSC 52, gated) + drag-drop file → quoted path.

**P2 — shell integration:**
11. OSC 133/OSC 7 injection scripts (zsh/bash/fish) for the shell slot; jump-to-prompt,
    select-command-output, cwd inheritance.

**P3 — surfaces:**
12. Shell splits/tabs per worktree (slot key scheme + UI). The big one.
13. Light/dark auto-switch; terminal color-scheme picker (iTerm2 scheme import).
14. `@xterm/addon-image` (sixel + iTerm IIP).

**P4 — chrome & polish (pick by appetite):**
15. Window opacity/blur (Tauri windowEffects), Quick-Terminal global hotkey, secure keyboard entry,
    auto-updater, overlay scrollbar for the shell pane, keybind customization.

**Explicit non-goals (agreed by writing them down):** Metal renderer / custom shaders, Kitty graphics
& keyboard protocols, DECSLRM, rectangular selection (all upstream-xterm.js or native-only);
AppleScript/Shortcuts/Quick Look/proxy icon/native tabs (native chrome); anything that reintroduces
the deleted notification/bell system (OSC 9/777, command-finished notify, bell features).

## Sources

Ghostty: ghostty.org docs (config reference w/ `Available since` tags, VT reference, features,
release notes 1.0→1.3.1), `ghostty-org/ghostty` source (`modes.zig`, `osc.zig`, `Binding.zig`,
`device_attributes.zig`), maintainer statements on sixel (discussions #2496/#5832).
Trickshot: full read of `terminal.ts`, `terminal.rs`, `TerminalPane.svelte`,
`ClaudeTerminalPane.svelte`, `themes.ts`, `termProfiles.ts`, `stores.ts`, `Settings*.svelte`,
`package.json`/`bun.lock` (July 2026, branch point `ae9943f`).
