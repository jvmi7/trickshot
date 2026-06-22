// Entrypoint for Windows x64. Note the binary subpath is claude.exe.

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import binPath from "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe" with { type: "file" };
import { run } from "./core";

run(extractFromBunfs(binPath));
