// Entrypoint for macOS x64.

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-x64/claude" with { type: "file" };
import { run } from "./core";

run(extractFromBunfs(binPath));
