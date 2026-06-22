// Entrypoint for Linux arm64 (glibc).

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import binPath from "@anthropic-ai/claude-agent-sdk-linux-arm64/claude" with { type: "file" };
import { run } from "./core";

run(extractFromBunfs(binPath));
