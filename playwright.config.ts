import { defineConfig } from '@playwright/test';
const preview = process.env.RDD2_PREVIEW === '1';
const baseURL = preview ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:5173';
export default defineConfig({
  testDir: 'tests/browser',
  // Frame-timing and software WebGL tests need the same single-worker execution used before splitting the suite.
  workers: 1,
  use: { baseURL, headless: true },
  webServer: {
    command: preview ? 'npm run preview -- --strictPort' : 'npm run dev -- --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI && !preview,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
      },
    },
  ],
});
