const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.browser.cjs',
  timeout: 45000,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', channel: 'chromium', headless: true, viewport: { width: 1440, height: 1060 }, acceptDownloads: true }
});
