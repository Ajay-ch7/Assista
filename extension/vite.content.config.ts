import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Content scripts cannot import modules, so this build emits a single classic script.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'AssistaContent',
      fileName: () => 'content.js',
    },
  },
});
