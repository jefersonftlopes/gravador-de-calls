// Service worker (MV3). Liga as partes: sessões (Port do relay), API do popup, modo aba,
// recuperação na inicialização e reação às configurações.
import { ensureProfileId, loadRecent, loadSettings, onSettingsChanged } from '../shared/settings'
import { onConsentChanged } from '../shared/consent'
import { initLanguage } from '../shared/i18n'
import { markTabsOpenedBeforeInstall, refreshConsentBadge, registerBadge, setUpdateBadge } from './badge'
import { registerApiTranscriptionAlarms, runApiQueue } from './api-transcription'
import { onAutoReloadState, registerAutoReload } from './auto-reload'
import { registerMic } from './mic'
import { onInstalledConsent } from './welcome'
import { countChunks, listSessions } from './idb'
import { ensureOffscreen, sendToOffscreen } from './offscreen-doc'
import {
  activeRecordings,
  broadcastSettings,
  onPageSessionEnded,
  onTabRemoved,
  recoverSessions,
  registerSessionAlarms,
  registerSessionPorts,
  stopSession,
  waitTabSessionSaved,
} from './sessions'
import { pingHost } from './sink-host'
import { registerTabCapture } from './tabcapture'
import { testHooks } from './testing'
import { registerUiApi } from './ui-api'
import { broadcastVigiaConfig, registerVigiaPorts } from './vigia'

// Emenda 19: o idioma escolhido nas configurações. Primeiro de tudo: o ouvinte do storage entra
// nesta volta do laço (a troca de idioma acorda o SW), e cada texto visível espera a leitura
// (languageReady) antes de sair.
void initLanguage()

// Todos os ouvintes de eventos do SW são registrados aqui, no carregamento (é o que acorda o SW).
// Cada fatia preenche o seu register*() no arquivo dela, sem mexer nesta lista.
registerSessionPorts()
registerSessionAlarms()
// Emenda 21: as tentativas da transcrição por API, pelo mesmo caminho durável do RECOVER_ALARM.
registerApiTranscriptionAlarms()
registerVigiaPorts()
registerUiApi()
registerTabCapture()
// Emenda 25: a gravação da própria voz, por aba. Desligada no perfil, nada acontece.
registerMic()
registerBadge()
// Emenda 17: a cópia publicada recarrega sozinha quando nada está em uso; até lá, o badge avisa.
onAutoReloadState((s) => void setUpdateBadge(s ? s.published.version : null))
registerAutoReload()

// Dono das sessões no helper (Emenda 1): gerado uma vez por perfil.
void ensureProfileId()

chrome.tabs.onRemoved.addListener((tabId) => onTabRemoved(tabId))
onSettingsChanged((s) => {
  void broadcastSettings()
  broadcastVigiaConfig(s)
})
// Emenda 15: confirmar o aviso da primeira execução libera a gravação automática nas abas abertas.
onConsentChanged(() => {
  void broadcastSettings()
  void refreshConsentBadge()
})
void refreshConsentBadge()

// AC16: abas de call abertas antes da instalação/atualização não têm os content scripts.
chrome.runtime.onInstalled.addListener((details) => {
  const matches = chrome.runtime.getManifest().content_scripts?.flatMap((c) => c.matches ?? []) ?? []
  void markTabsOpenedBeforeInstall([...new Set(matches)])
  // Emenda 15: na instalação, a página de boas-vindas com o aviso; na atualização vinda de antes
  // da 0.3.0 (sem aviso), a confirmação fica dada. As outras atualizações não confirmam nada.
  void onInstalledConsent(details)
})

// As configurações não são gravadas na instalação: loadSettings() já aplica os padrões do
// ESPEC a cada leitura. Gravar aqui corria contra quem acabou de salvar (perdia a escolha).

// Recupera sessões abertas sempre que o SW sobe (Chrome reiniciado ou SW acordado).
void recoverSessions()
// Emenda 21: a fila da transcrição por API sobrevive ao SW: uma passada em todo carregamento.
void runApiQueue()

// Gancho de depuração e de teste (Playwright usa via serviceWorker.evaluate). Só leitura e
// ações que o popup também tem; nada aqui escapa da extensão. `testing` é o registro de
// ganchos de teste (./testing.ts) que cada fatia preenche no próprio register*(). O pacote da
// loja (Emenda 15) não expõe nada: o build com GRAVADOR_LOJA=1 apaga este bloco.
if (!__STORE_BUILD__) Object.assign(globalThis, {
  __gravador: {
    activeRecordings,
    listSessions,
    countChunks,
    loadSettings,
    loadRecent,
    pingHost,
    stopSession,
    waitTabSessionSaved,
    onPageSessionEnded,
    ensureOffscreen,
    sendToOffscreen,
    testing: testHooks,
  },
})
