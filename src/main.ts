import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initThemedCursor } from "./lib/themedCursor";

// Svelte 5 mount API.
const app = mount(App, {
  target: document.getElementById("app")!,
});

initThemedCursor();

export default app;
