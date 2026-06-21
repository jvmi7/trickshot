import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri-tuned Vite config: fixed dev port, don't clobber Tauri's terminal output,
// and ignore the Rust source tree so HMR doesn't thrash on Cargo builds.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
