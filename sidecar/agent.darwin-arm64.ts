// Entrypoint for macOS arm64. Embeds the matching native Claude Code binary so
// `bun build --compile` can ship it inside the single-file executable.
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { run } from "./core";

run(extractFromBunfs(binPath));
