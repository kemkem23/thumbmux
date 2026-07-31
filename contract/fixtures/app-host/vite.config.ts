/*
 * FROZEN CONSUMER FIXTURE (RULES §9).
 * Changes require a matching contract manifest change and the CONTRACT.md
 * deprecation procedure.
 */
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
});
