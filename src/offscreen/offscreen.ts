// Documento offscreen (motivos BLOBS + USER_MEDIA + AUDIO_PLAYBACK, aberto só por
// src/background/offscreen-doc.ts): roteia as mensagens do SW para os handlers de cada fatia.
// Este arquivo não muda quando uma fatia implementa o seu handler (./blob.ts, ./tab.ts).
import type { OffscreenReq } from '../shared/protocol'
import { BAKED } from '../shared/baked'
import { blobHandlers } from './blob'
import type { OffscreenHandlers, OffscreenType } from './handlers'
import { micHandlers } from './mic'
import { tabHandlers } from './tab'

/**
 * Emenda 17: o documento é lido do disco quando o SW o abre, então um SW antigo pode abrir um
 * offscreen novo. A versão dele fica no log e responde ao offscreen:version, para diagnóstico e
 * para o teste ponta a ponta (versao.spec.ts). O SW não pergunta nem compara: quem avisa da versão
 * diferente é o popup e as configurações, pelo ui:state (VersionBanner).
 */
const versionHandlers: OffscreenHandlers<'offscreen:version'> = { 'offscreen:version': async () => BAKED }
console.debug('[gravador offscreen] versão', BAKED.version, BAKED.build)

const handlers: OffscreenHandlers<OffscreenType> = { ...blobHandlers, ...tabHandlers, ...micHandlers, ...versionHandlers }

chrome.runtime.onMessage.addListener((msg: OffscreenReq, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || !(msg.t in handlers)) return false
  const handler = handlers[msg.t] as (r: OffscreenReq) => Promise<unknown>
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }))
  return true
})
