// playwright.config.js — конфиг e2e для Customs X-Ray
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    actionTimeout: 15000,
    viewport: { width: 1280, height: 800 }
  },
  webServer: {
    command: 'node e2e-server.js',
    port: 3000,
    timeout: 20000,
    reuseExistingServer: true
  }
});