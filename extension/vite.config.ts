import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// Builds the panel page, the permission page script and the service worker as ES modules.
// The content script must be one classic script, so vite.content.config.ts builds it.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '..'), '');
  return {
    define: {
      __BACKEND_WS_URL__: JSON.stringify(env.BACKEND_WS_URL || 'ws://127.0.0.1:8000/ws'),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'chrome120',
      minify: false,
      modulePreload: false,
      rollupOptions: {
        input: {
          panel: resolve(import.meta.dirname, 'src/panel/index.html'),
          permission: resolve(import.meta.dirname, 'src/panel/permission.ts'),
          background: resolve(import.meta.dirname, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
