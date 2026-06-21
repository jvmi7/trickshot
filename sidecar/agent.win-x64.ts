// Entrypoint for Windows x64. Note the binary subpath is claude.exe.
import binPath from "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { run } from "./core";

run(extractFromBunfs(binPath));
