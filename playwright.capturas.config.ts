// Capturas da Chrome Web Store (tests/capturas): fora da suíte de ponta a ponta (npm run capturas).
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/capturas',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/helpers/global-setup.ts',
  outputDir: 'test-results',
})
