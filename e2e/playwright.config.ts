import { defineConfig } from '@playwright/test';

if (!process.env.DEMO_URL) {
  throw new Error('Set DEMO_URL to the running thumbmux demo URL before running e2e tests.');
}

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.DEMO_URL,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
  },
});
