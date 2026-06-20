import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  root: "ui",
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true
  }
});
