// Testes de unidade (vitest). Sem o plugin do crxjs: só código puro e o helper Node.
import { defineConfig } from 'vitest/config'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  // O mesmo `define` do vite.config.ts no build de desenvolvimento (Emenda 15).
  define: { __STORE_BUILD__: 'false', __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_ID__: JSON.stringify('vitest') },
  test: {
    environment: 'node',
    // chrome.i18n falso com as mensagens de verdade (pt_BR por padrão; os testes trocam o idioma).
    setupFiles: ['tests/helpers/i18n-setup.ts'],
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
})
