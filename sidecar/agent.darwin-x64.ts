// Entrypoint for macOS x64.
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-x64/claude" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { run } from "./core";

run(extractFromBunfs(binPath));
