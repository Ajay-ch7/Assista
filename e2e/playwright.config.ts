import { defineConfig } from '@playwright/test';

export const BACKEND_PORT = 8765;
export const DEMO_PORT = 8787;

// The tests run in text mode against the mock model, so they need no keys, microphone or
// speaker. Build the extension first: `npm run build` in ../extension.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  webServer: [
    {
      command: `uv run uvicorn app.main:app --host 127.0.0.1 --port ${BACKEND_PORT}`,
      cwd: '../backend',
      url: `http://127.0.0.1:${BACKEND_PORT}/health`,
      env: { LLM_PROVIDER: 'mock', STT_PROVIDER: 'mock', TTS_PROVIDER: 'mock' },
      reuseExistingServer: false,
    },
    {
      command: `uv run python -m http.server ${DEMO_PORT} --bind 127.0.0.1 --directory ../demo-pages`,
      cwd: '../backend',
      url: `http://127.0.0.1:${DEMO_PORT}/shop.html`,
      reuseExistingServer: false,
    },
  ],
});
