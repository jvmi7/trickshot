import "./app.css";
import "lineicons/dist/lineicons.css"; // LineIcons webfont (use via <i class="lni lni-…">)
import { mount } from "svelte";
import App from "./App.svelte";
import { initThemedCursor } from "./lib/themedCursor";

// Svelte 5 mount API.
const app = mount(App, {
  target: document.getElementById("app")!,
});

initThemedCursor();

export default app;
