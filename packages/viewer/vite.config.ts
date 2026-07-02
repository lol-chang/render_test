import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Import @origami/core straight from its TypeScript source (Vite/esbuild transpiles
// on the fly), so the viewer always tracks the live engine without a build step.
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@origami/core': coreSrc,
    },
  },
  server: {
    port: 5173,
    open: false,
  },
});
