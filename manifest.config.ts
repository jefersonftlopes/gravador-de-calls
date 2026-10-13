import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }
import extensionKey from './extension-key.json' with { type: 'json' }
import { CALL_MATCHES as HOST_MATCHES } from './src/shared/hosts.ts'
import { declaredApiOrigins, optionalApiOrigins } from './src/shared/api-transcription.ts'

/**
 * Build para a Chrome Web Store (scripts/empacotar.mjs, GRAVADOR_LOJA=1): sem a chave de
 * desenvolvimento, com o site em homepage_url e sem os ganchos de teste (vite.config.ts troca
 * __STORE_BUILD__). Emendas 13 e 15.
 */
export const STORE_BUILD = process.env.GRAVADOR_LOJA === '1'

/** Site da extensão (política de privacidade), só no pacote da loja. */
export const SITE_URL = 'https://gravador-de-calls.vercel.app'

/**
 * Hosts das calls, gerados da fonte única (src/shared/hosts.ts, Emenda 17): os do Meet e do Teams e
 * as formas pelo proxy do Defender for Cloud Apps (.mcas.ms, .mcas-gov.us, .mcas-gov.ms).
 */
export const CALL_MATCHES: string[] = [...HOST_MATCHES]

interface ContentScript {
  matches: string[]
  js: string[]
  run_at: 'document_start' | 'document_end' | 'document_idle'
  all_frames: boolean
  // Chrome 119+; o tipo do crxjs ainda não tem o campo, por isso o cast no uso.
  match_origin_as_fallback: boolean
  world?: 'MAIN' | 'ISOLATED'
}

const contentScripts: ContentScript[] = [
  {
    // Ganchos no MAIN world, antes de qualquer script da página (o Meet e o Teams criam a
    // RTCPeerConnection cedo). O crxjs 3 gera os arquivos *.iife.ts como IIFE síncrono e
    // autocontido, referenciado direto aqui (sem loader e sem import()).
    // Divergência declarada do jeito comum (injetar <script src> no document_idle): tarde demais
    // para este caso.
    matches: CALL_MATCHES,
    js: ['src/main-world/hook.iife.ts'],
    run_at: 'document_start',
    all_frames: true,
    match_origin_as_fallback: true,
    world: 'MAIN',
  },
  {
    // Relay ISOLATED: ponte window.postMessage <-> Port do service worker.
    matches: CALL_MATCHES,
    js: ['src/content/relay.ts'],
    run_at: 'document_start',
    all_frames: true,
    match_origin_as_fallback: true,
  },
  {
    // Vigia (sair e fechar a call sozinho, Emendas 2 e 3): ISOLATED, só a frame do topo, depois
    // do DOM pronto. É só DOM e element.click(); não precisa do MAIN world.
    matches: CALL_MATCHES,
    js: ['src/content/vigia/vigia.ts'],
    run_at: 'document_idle',
    all_frames: false,
    match_origin_as_fallback: false,
  },
]

export default defineManifest({
  manifest_version: 3,
  // Emenda 15: nome, descrição, título do ícone e descrição do atalho vêm de public/_locales
  // (en é o padrão; pt_BR para quem usa o Chrome em português).
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  default_locale: 'en',
  version: pkg.version,
  // Chave pública fixa SÓ no build de desenvolvimento: o ID da extensão não muda entre máquinas e
  // o helper de native messaging pode listá-lo em allowed_origins. A chave privada fica em .keys/
  // (fora do git). O pacote da Chrome Web Store (npm run empacotar, GRAVADOR_LOJA=1) sai sem ela:
  // a loja recusa "key" e dá o ID dela (Emenda 13, docs/LOJA.md).
  ...(STORE_BUILD ? { homepage_url: SITE_URL } : { key: extensionKey.key }),
  // 120: world MAIN no manifesto (111), match_origin_as_fallback (119), AudioContext com
  // sinkId { type: 'none' } (110), tabCapture.getMediaStreamId no SW (116), runtime.getContexts (116).
  minimum_chrome_version: '120',
  action: {
    default_title: '__MSG_actionTitle__',
    default_popup: 'src/popup/index.html',
    // 32 px para a barra em tela retina (o de 16 px tem desenho próprio, alinhado ao pixel).
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
    },
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  commands: {
    'gravar-aba': {
      suggested_key: { default: 'Alt+Shift+G', mac: 'Alt+Shift+G' },
      description: '__MSG_commandTabMode__',
    },
  },
  // Tipado pela interface ContentScript acima; o crxjs tem dois tipos de content script
  // incompatíveis entre si (world string x 'MAIN' | 'ISOLATED') e nenhum com match_origin_as_fallback.
  content_scripts: contentScripts as never,
  // Sem a permissão "tabs": os host_permissions das calls já dão URL e título dessas abas
  // (popup, varredura de abas abertas antes da instalação), e tabs.update/onRemoved não exigem
  // permissão. Menos escopo, menos aviso na instalação.
  permissions: [
    'storage', // configurações e últimas gravações
    'unlimitedStorage', // IndexedDB com o áudio até salvar (nunca bater na cota)
    'offscreen', // Blob para downloads e gravadores do modo aba
    'nativeMessaging', // helper local que grava na pasta escolhida
    'downloads', // reserva quando o helper não está instalado
    'notifications', // aviso de "sem áudio" e de "recarregue a aba"
    'tabCapture', // modo aba (plano B)
    // Modo aba em outro site (Emenda 7): título e URL da aba no gesto que já libera a captura
    // (atalho, ícone, botão do popup). Não pede nada na instalação nem dá acesso fora do gesto.
    'activeTab',
    'alarms', // recuperação de sessões abertas depois de uma queda
  ],
  // Emenda 21: no build de desenvolvimento entra também o loopback do servidor falso dos testes
  // (o pacote da loja não o leva): o chrome.permissions.request de host não resolve no headless.
  host_permissions: [...CALL_MATCHES, ...declaredApiOrigins(STORE_BUILD)],
  /**
   * Emenda 21: a API de transcrição do provedor, pedida na hora em que o usuário liga o motor por
   * API (chrome.permissions.request, na página de configurações). É OPCIONAL de propósito: quem não
   * liga o motor nunca vê este pedido, e nada é enviado sem ele. Nada de `https://*&#47;*`: só a
   * origem declarada em src/shared/api-transcription.ts (API_PROVIDERS). No build de
   * desenvolvimento entra também o loopback do servidor falso dos testes, que o pacote da loja não
   * leva (allowedApiOrigins(STORE_BUILD) é a mesma lista que a extensão aceita como endereço).
   */
  optional_host_permissions: optionalApiOrigins(),
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
})
