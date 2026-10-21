// IndexedDB da extensão: fonte da verdade até a gravação ser salva (sobrevive a queda da aba,
// do service worker e do Chrome). O SW e o documento offscreen (mesma origem) abrem o mesmo
// banco. Banco `gravador` versão 2:
//   sessions  chave sessionId
//   chunks    chave [sessionId, seq], valor { sessionId, seq, data: Blob, at }
//   apiAudio  chave sessionId (Emenda 21): o áudio guardado para transcrever por API
//
// Emenda 21, versão 2: os pedaços (chunks) saem do banco assim que a gravação é salva
// (deleteChunks), e a extensão NÃO consegue ler de volta o arquivo que o helper gravou no disco.
// Para transcrever por API o áudio tem de estar disponível DEPOIS de salvar, então ele é guardado
// aqui, em UM Blob montado, com política de retenção (src/shared/api-transcription.ts).
//
// Por que um Blob montado e não os pedaços soltos: os pedaços são de 5 s (RECORDING_TIMESLICE_MS),
// então uma call de 1 h tem cerca de 720 registros, e cada tentativa de envio teria de ler e
// concatenar os 720 de novo; o `deleteChunks` do finalize teria de aprender a poupar uns e não
// outros; e o tamanho total, que a retenção e o limite de 25 MB precisam saber, só sairia somando
// tudo. Com um registro por gravação, a leitura é uma, o tamanho é `bytes`, e o `deleteChunks`
// continua como estava.
import type {
  AutoLeaveInfo,
  CallMeta,
  CaptureDiag,
  ChunkGap,
  EndReason,
  HoldPeriod,
  InfoJson,
  RecordingPlatform,
  SeamSwitch,
  SessionKind,
  SessionStatus,
  SinkKind,
  SpeakersFile,
} from '../shared/protocol'
import type { SpeakerTimelineRecord } from '../shared/speakers'

export const DB_NAME = 'gravador'
/** 2 (Emenda 21): a loja `apiAudio`. A 1 tinha só `sessions` e `chunks`. */
export const DB_VERSION = 2
/** Loja do áudio guardado para transcrever por API (Emenda 21). */
export const API_AUDIO_STORE = 'apiAudio'

export interface SessionRecord {
  sessionId: string
  /** ID local da frame (deduplica um session:start reenviado depois de reconectar). */
  localId: string
  tabId: number
  frameId: number
  platform: RecordingPlatform
  kind: SessionKind
  status: SessionStatus
  startedAt: number
  endedAt: number | null
  endReason: EndReason | null
  meta: Partial<CallMeta>
  diag: CaptureDiag | null
  seamSwitches: SeamSwitch[]
  holds: HoldPeriod[]
  /** Próximo seq esperado (todos os anteriores estão no store chunks). */
  nextSeq: number
  /** lastSeq anunciado no session:end (-1 se nenhum). */
  lastSeq: number | null
  bytes: number
  lastChunkAt: number | null
  gaps: ChunkGap[]
  /** Destino escolhido no início (o fim pode cair para downloads). */
  sink: SinkKind | null
  /** Raiz que o helper usou no begin (informativo: quem guarda a raiz da sessão é o helper). */
  root: string
  /** Dono no helper: o profileId deste perfil (Emenda 1). */
  owner: string
  /** Nome do perfil no início (vira a primeira pasta e o campo `perfil` do info.json). */
  profileLabel: string
  /** O vigia saiu sozinho (Emenda 2). */
  autoLeave: AutoLeaveInfo | null
  /** Emenda 18: linha do tempo dos falantes (ausente em registros antigos e no modo aba). */
  speakers?: SpeakerTimelineRecord | null
  /** Quantos chunks o helper já confirmou (ordinal do próximo append). */
  hostFlushedSeq: number
  /** Arquivo final na pasta da call (`audio.webm` na página, `audio-aba.webm` no modo aba). */
  file: string
  /** Modo aba e microfone: sessão de página da mesma aba cuja pasta deve receber este arquivo. */
  pairedSessionId: string | null
  /**
   * Emenda 25 (só `kind: 'microfone'`): o portão do mudo já abriu alguma vez nesta gravação. Nunca
   * aberto quer dizer que nada chegou ao gravador, então a sessão é DESCARTADA e nenhum
   * audio-microfone.webm aparece na pasta: não se escreve um arquivo de silêncio.
   */
  micEverOpen?: boolean
  /**
   * Emenda 25 (só `kind: 'microfone'`): quantos ms esta gravação começou DEPOIS da sessão de
   * página da mesma aba. Vai no `desvioMs` do info.json: os dois arquivos saem do mesmo atraso de
   * MIXER_DELAY_MS, então é só este número que falta para casar os dois no tempo.
   */
  micSkewMs?: number
  /** Pasta final e erro do último salvamento. */
  savedPath: string | null
  lastError: string | null
  /**
   * Sessão do navegador em que a gravação começou (chrome.storage.session, que some quando o
   * Chrome fecha ou cai). Na recuperação, uma sessão de outro boot não tem mais quem a retome:
   * vira "interrompida" na hora, sem esperar 30 s. Ausente em registros antigos.
   */
  bootId?: string | null
  /**
   * Reserva downloads: o info.json pronto, guardado só enquanto o offscreen monta o Blob dele
   * (`offscreen:blob-url` com `application/json` lê daqui). Volta a null depois.
   */
  downloadInfo?: string | null
}

export interface ChunkRecord {
  sessionId: string
  seq: number
  data: Blob
  at: number
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const current: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'sessionId' })
        s.createIndex('status', 'status')
      }
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] })
      // Emenda 21: um registro por gravação esperando a transcrição por API.
      if (!db.objectStoreNames.contains(API_AUDIO_STORE)) db.createObjectStore(API_AUDIO_STORE, { keyPath: 'sessionId' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      // Fechada sem pedirmos (erro do armazenamento, disco): a próxima operação abre de novo, em
      // vez de falhar para sempre com a conexão em cache (Emenda 10).
      db.onclose = () => {
        if (dbPromise === current) dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      if (dbPromise === current) dbPromise = null
      reject(req.error)
    }
  })
  dbPromise = current
  return current
}

/**
 * Abre uma transação; se a conexão em cache já está fechando (InvalidStateError), esquece ela
 * e abre outra uma vez.
 */
async function tx(stores: string | string[], mode: IDBTransactionMode = 'readonly'): Promise<IDBTransaction> {
  const db = await openDb()
  try {
    return db.transaction(stores, mode)
  } catch (e) {
    dbPromise = null
    try {
      db.close()
    } catch {
      // nada
    }
    if ((e as DOMException)?.name !== 'InvalidStateError') throw e
    return (await openDb()).transaction(stores, mode)
  }
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('transação abortada'))
  })
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function putSession(rec: SessionRecord): Promise<void> {
  const t = await tx('sessions', 'readwrite')
  t.objectStore('sessions').put(rec)
  await done(t)
}

export async function getSession(sessionId: string): Promise<SessionRecord | undefined> {
  return result((await tx('sessions')).objectStore('sessions').get(sessionId)) as Promise<SessionRecord | undefined>
}

export async function listSessions(status?: SessionStatus): Promise<SessionRecord[]> {
  const store = (await tx('sessions')).objectStore('sessions')
  const req = status ? store.index('status').getAll(status) : store.getAll()
  return result(req) as Promise<SessionRecord[]>
}

export async function deleteSession(sessionId: string): Promise<void> {
  const t = await tx('sessions', 'readwrite')
  t.objectStore('sessions').delete(sessionId)
  await done(t)
}

/** Grava o chunk e o estado da sessão na MESMA transação (o ack só sai depois disso). */
export async function putChunkAndSession(chunk: ChunkRecord, rec: SessionRecord): Promise<void> {
  const t = await tx(['chunks', 'sessions'], 'readwrite')
  t.objectStore('chunks').put(chunk)
  t.objectStore('sessions').put(rec)
  await done(t)
}

export async function getChunk(sessionId: string, seq: number): Promise<ChunkRecord | undefined> {
  return result((await tx('chunks')).objectStore('chunks').get([sessionId, seq])) as Promise<ChunkRecord | undefined>
}

/** Todos os chunks da sessão, em ordem de seq. */
export async function getChunks(sessionId: string): Promise<ChunkRecord[]> {
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
  return result((await tx('chunks')).objectStore('chunks').getAll(range)) as Promise<ChunkRecord[]>
}

export async function countChunks(sessionId?: string): Promise<number> {
  const store = (await tx('chunks')).objectStore('chunks')
  const req = sessionId ? store.count(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])) : store.count()
  return result(req)
}

export async function deleteChunks(sessionId: string): Promise<void> {
  const t = await tx('chunks', 'readwrite')
  t.objectStore('chunks').delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]))
  await done(t)
}

// Áudio guardado para a transcrição por API (Emenda 21) ------------------------------------------

/**
 * Uma gravação esperando a transcrição por API. Guarda tudo o que a saída precisa, então não
 * depende do registro da sessão (que o pruneOldRecords pode apagar) nem de ler a pasta no disco.
 */
export interface ApiAudioRecord {
  sessionId: string
  /** O áudio inteiro num Blob só (ver o comentário do topo). */
  blob: Blob
  bytes: number
  /** Nome do arquivo de áudio na pasta da call (`audio.webm`). */
  audio: string
  /** Pasta final da call: do helper (absoluta) ou relativa à pasta de downloads. */
  savedPath: string
  /** Onde a gravação foi salva: decide por onde a transcrição é escrita. */
  sink: SinkKind
  /** O info.json da gravação (cabeçalho do transcricao.md) e a linha do tempo dos falantes. */
  info: InfoJson
  speakers: SpeakersFile | null
  createdAt: number
  /** Tentativas de envio já feitas. */
  attempts: number
  /** Quando a próxima tentativa pode acontecer (espera crescente). */
  nextAt: number
  /** Motivo da última falha, já no idioma da interface (para o popup). */
  lastError: string | null
}

export async function putApiAudio(rec: ApiAudioRecord): Promise<void> {
  const t = await tx(API_AUDIO_STORE, 'readwrite')
  t.objectStore(API_AUDIO_STORE).put(rec)
  await done(t)
}

export async function getApiAudio(sessionId: string): Promise<ApiAudioRecord | undefined> {
  return result((await tx(API_AUDIO_STORE)).objectStore(API_AUDIO_STORE).get(sessionId)) as Promise<ApiAudioRecord | undefined>
}

export async function listApiAudio(): Promise<ApiAudioRecord[]> {
  return result((await tx(API_AUDIO_STORE)).objectStore(API_AUDIO_STORE).getAll()) as Promise<ApiAudioRecord[]>
}

export async function deleteApiAudio(sessionId: string): Promise<void> {
  const t = await tx(API_AUDIO_STORE, 'readwrite')
  t.objectStore(API_AUDIO_STORE).delete(sessionId)
  await done(t)
}
