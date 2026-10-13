// Registro dos ganchos de teste do SW, expostos em `__gravador.testing` (Emenda 5).
//
// Cada fatia registra os seus ganchos de dentro do próprio register*() (chamado por index.ts no
// carregamento do SW), sem editar index.ts. O produto nunca chama nada daqui: só o Playwright,
// por serviceWorker.evaluate. Os ganchos guardam estado só em memória (um reinício do SW zera
// tudo, então o teste arma de novo depois de derrubar o SW).
export type TestHook = (...args: never[]) => unknown

export const testHooks: Record<string, TestHook> = {}

/**
 * Registra ganchos com nomes únicos. Nome repetido é erro de contrato entre fatias. No pacote da
 * loja (Emenda 15) não registra nada: o registro fica vazio e nem é exposto (index.ts).
 */
export function registerTestHooks(hooks: Record<string, TestHook>): void {
  if (__STORE_BUILD__) return
  for (const [name, fn] of Object.entries(hooks)) {
    if (name in testHooks && testHooks[name] !== fn) throw new Error(`gancho de teste repetido: ${name}`)
    testHooks[name] = fn
  }
}
