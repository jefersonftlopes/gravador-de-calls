// Constantes de build trocadas pelo Vite (`define` em vite.config.ts e vitest.config.ts).

/** true só no pacote da Chrome Web Store (npm run empacotar, GRAVADOR_LOJA=1): sem ganchos de teste. */
declare const __STORE_BUILD__: boolean

/** Versão do package.json no momento do build (Emenda 17), a mesma em todo bundle. */
declare const __APP_VERSION__: string

/** Identificador do build: hash das entradas (scripts/build-info.mjs, Emenda 17). */
declare const __BUILD_ID__: string
