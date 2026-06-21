#!/usr/bin/env bash
# Compile the sidecar for the HOST platform and place it where Tauri expects it
# (src-tauri/binaries/agent-<rust-target-triple>[.exe]).
#
# Run this once before `bun run dev`, and again whenever sidecar/*.ts changes.
# For cross-platform release builds, replicate this per target with bun's --target
# flag (see README) — Bun's --target names differ from Rust target triples.
set -euo pipefail

cd "$(dirname "$0")/.."

# Rust host triple — the suffix Tauri looks for.
TRIPLE="$(rustc -Vv | grep '^host:' | cut -d' ' -f2)"

case "$TRIPLE" in
  aarch64-apple-darwin)        ENTRY="sidecar/agent.darwin-arm64.ts" ;;
  x86_64-apple-darwin)         ENTRY="sidecar/agent.darwin-x64.ts" ;;
  x86_64-unknown-linux-gnu)    ENTRY="sidecar/agent.linux-x64.ts" ;;
  aarch64-unknown-linux-gnu)   ENTRY="sidecar/agent.linux-arm64.ts" ;;
  x86_64-pc-windows-msvc)      ENTRY="sidecar/agent.win-x64.ts" ;;
  *) echo "Unsupported host triple: $TRIPLE" >&2; exit 1 ;;
esac

mkdir -p src-tauri/binaries
OUT="src-tauri/binaries/agent-$TRIPLE"

echo "Building $ENTRY -> $OUT"
bun build "$ENTRY" --compile --outfile "$OUT"
# Bun appends .exe automatically on Windows targets; Tauri expects that suffix too.

echo "Done."
