// Entrypoint for Linux arm64 (glibc).
import binPath from "@anthropic-ai/claude-agent-sdk-linux-arm64/claude" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { run } from "./core";

run(extractFromBunfs(binPath));
