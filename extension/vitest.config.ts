import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __BACKEND_WS_URL__: JSON.stringify('ws://127.0.0.1:8000/ws'),
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
