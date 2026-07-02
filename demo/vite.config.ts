import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      '@thumbmux/core': r('../core/src'),
      '@thumbmux/svelte': r('../svelte/src'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
