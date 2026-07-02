import "./app.css";
import { mount } from "svelte";
import { installThemes } from "./lib/themes";

async function boot() {
  // Browser-mode E2E harness (`vite --mode mock`): install the fake Tauri
  // backend BEFORE the app graph loads. The App import below is dynamic ON
  // PURPOSE — stores.ts reads localStorage at module-eval time, so the mock's
  // seeding must run first, and a static import would hoist the whole graph
  // above it. `import.meta.env.MODE` is statically replaced at build time, so
  // the mock module is dead-code-eliminated from prod builds.
  if (import.meta.env.MODE === "mock") {
    (await import("./lib/mockBackend")).installMockBackend();
  }

  // Inject the color-theme CSS (generated from the themes.ts config) before
  // mount, so the active `<html data-theme>` is styled on first paint.
  installThemes();

  const { default: App } = await import("./App.svelte");

  // Svelte 5 mount API.
  mount(App, {
    target: document.getElementById("app")!,
  });
}

void boot();
