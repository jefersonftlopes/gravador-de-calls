// Ponta a ponta: Chromium do Playwright (Chrome for Testing) em headless "novo", com a extensão
// de dist/ carregada por --load-extension e um perfil temporário por teste.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/helpers/global-setup.ts',
  outputDir: 'test-results',
})
