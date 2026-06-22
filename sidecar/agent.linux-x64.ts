// Entrypoint for Linux x64 (glibc). Use the -linux-x64-musl package on Alpine.

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import binPath from "@anthropic-ai/claude-agent-sdk-linux-x64/claude" with { type: "file" };
import { run } from "./core";

run(extractFromBunfs(binPath));
