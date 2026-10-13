import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import manifest, { STORE_BUILD } from './manifest.config.ts'
import { BUILD_INFO_FILE, buildInfo } from './scripts/build-info.mjs'

// Emenda 17: versão e identificador do build embutidos em todo bundle (SW, popup, configurações,
// offscreen), para cada parte saber se está rodando o mesmo código das outras.
const BUILD = buildInfo({ store: STORE_BUILD })

export default defineConfig({
  // Pacote da loja (Emenda 15): __STORE_BUILD__ true apaga os ganchos de teste do SW.
  define: {
    __STORE_BUILD__: JSON.stringify(STORE_BUILD),
    __APP_VERSION__: JSON.stringify(BUILD.version),
    __BUILD_ID__: JSON.stringify(BUILD.build),
  },
  plugins: [
    react(),
    {
      // dist/versao.json: o npm run publicar copia o identificador para o publicado.json.
      name: 'gravador-versao',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: BUILD_INFO_FILE, source: `${JSON.stringify(BUILD)}\n` })
      },
    },
    tailwindcss(),
    crx({
      manifest,
      // O relay também precisa estar ouvindo no document_start (o hook manda o hello cedo):
      // sai como IIFE autocontido, igual aos arquivos *.iife.ts. O vigia também (Emenda 10): o
      // carregador padrão do crxjs faz import() de um arquivo com hash, que some num rebuild com a
      // aba aberta, e exige web_accessible_resources, que deixa qualquer página das calls achar a
      // extensão por uma URL fixa e ler o código dela.
      contentScripts: { standaloneFiles: ['src/content/relay.ts', 'src/content/vigia/vigia.ts'] },
    }),
  ],
  build: {
    target: 'es2022',
    // Mapas de fonte ajudam a depurar o MAIN world dentro do Meet/Teams.
    sourcemap: true,
    rollupOptions: {
      input: {
        offscreen: 'src/offscreen/offscreen.html',
        // Boas-vindas e aviso da primeira execução (Emenda 15): aberta pelo SW, não pelo manifesto.
        welcome: 'src/welcome/index.html',
      },
    },
  },
  server: {
    port: 5299,
    strictPort: true,
    hmr: { port: 5299 },
  },
})
