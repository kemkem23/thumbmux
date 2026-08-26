import { assertLocalDemoUrl, assertThumbmuxPlaywrightRuntime } from './test-runtime-guard';

assertThumbmuxPlaywrightRuntime();
const demoUrl = assertLocalDemoUrl(process.env.DEMO_URL);
const { defineConfig } = await import('@playwright/test');

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: demoUrl,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
  },
});
