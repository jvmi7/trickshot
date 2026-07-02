// E2E harness config — drives the webview in a real (headless) Chromium against
// the MOCK backend (`vite --mode mock`, see src/lib/mockBackend.ts). No Tauri,
// no Rust, no sidecar, no Claude login: this exercises the whole UI + api.ts
// parsing layer only. Specs are named *.e2e.ts (NOT *.test.ts/*.spec.ts) so
// `bun test` doesn't try to run them with the wrong runner.
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Claude's remote sandbox pre-installs a Chromium here (and blocks browser
// downloads); its revision may not match this Playwright version, so point at
// the binary directly. Locally the path won't exist and Playwright's own
// managed browser is used (`bunx playwright install chromium` once).
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";

// Port 1421 (not 1420) so the harness never collides with a running `bun run dev`.
const PORT = 1421;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "e2e/.results",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  // A stray `.only` silently hollows out the suite — hard-fail it in CI.
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: "only-on-failure",
    // On a CI retry, record a full trace (DOM snapshots, console, network) so a
    // flaky failure is debuggable from the uploaded artifact instead of by rerun.
    trace: "on-first-retry",
    ...(existsSync(SANDBOX_CHROMIUM)
      ? { launchOptions: { executablePath: SANDBOX_CHROMIUM } }
      : {}),
  },
  webServer: {
    command: `bunx vite --mode mock --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
