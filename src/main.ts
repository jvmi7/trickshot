import "./app.css";
import App from "./App.svelte";

// Svelte 4 mount API.
const app = new App({
  target: document.getElementById("app")!,
});

export default app;
