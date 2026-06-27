import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { installThemes } from "./lib/themes";

// Inject the color-theme CSS (generated from the themes.ts config) before mount,
// so the active `<html data-theme>` is styled on first paint.
installThemes();

// Svelte 5 mount API.
const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
