// Contrato dos adaptadores de plataforma (docs/ARQUITETURA.md, "Adaptadores de plataforma").
import type { CallMeta, EndReason, Platform, SeamId, SpeakerDiagnostics } from '../../shared/protocol'
import type { ContributingSource, Registry, RemoteAudioTrack } from '../capture/registry'
import type { Originals } from '../originals'
import type { SpeakerReading } from '../speakers/timeline'

/** O que a leitura de falantes recebe a cada 250 ms (Emenda 18). */
export interface SpeakerProbe {
  /** Agora (ms, relógio de época, o mesmo do Date.now e do carimbo do CSRC). */
  now: number
  /** CSRCs dos receptores de áudio vivos (só leitura). */
  contributingSources(): ContributingSource[]
  /**
   * O áudio dos outros que gravamos (o seam selecionado, medido ao vivo, sem o atraso) tem fala
   * agora? Ausente quando não se sabe (nenhum seam selecionado ainda, medida que falhou).
   */
  remoteSpeech?: boolean
}

/** O que o adaptador recebe na instalação para ouvir os sinais de falante (Emenda 18). */
export interface SpeakerSignalsContext {
  orig: Originals
  registry: Registry
  log: (...a: unknown[]) => void
}

/**
 * Estado dos PCs registrados, sem expor os objetos. Calculado pelo registry a cada 1 s.
 */
export interface Probe {
  /** Agora (ms), para o adaptador não precisar de relógio próprio. */
  now: number
  /** PCs registrados que não estão fechados. */
  pcsOpen: number
  /** PCs com connectionState === 'connected'. */
  pcsConnected: number
  /** Algum PC connected com receptor de áudio remoto vivo (e aceito pelo filtro do adaptador). */
  connectedWithLiveAudio: boolean
  /**
   * Algum PC que já esteve connected, com receptor de áudio vivo, está em 'disconnected' ou
   * 'connecting' (o ICE se recuperando de uma queda de rede). Emenda 10.
   */
  reconnectingWithAudio: boolean
  /** Quantas faixas remotas de áudio vivas existem agora. */
  liveRemoteAudioTracks: number
  /**
   * Quando um PC que carregava áudio remoto foi fechado (pc.close() embrulhado ou estado 'closed'
   * visto no polling); null se nunca. Volta a null quando outro PC passa a ter áudio.
   */
  audioPcClosedAt: number | null
}

export interface PlatformAdapter {
  id: Platform
  /** Gate: só nesta URL a sessão pode existir. Reavaliado a cada 1 s (SPA). */
  matchesUrl(loc: Location): boolean
  /** Prioridade dos seams para a arbitragem. */
  seamPriority: SeamId[]
  /**
   * Filtro opcional das faixas dos receptores, sobre o conjunto de todas as faixas remotas vivas
   * (Teams: se existe stream com id `mainAudio*`, só ele; os `dominantSpeaker-*` saem). Devolve o
   * subconjunto aceito. Emenda 5.
   */
  filterReceiverTracks?(all: readonly RemoteAudioTrack[]): readonly RemoteAudioTrack[]
  /** Está dentro da call? Avaliado a cada 1 s; a sessão exige 2 s estável para começar. */
  isInCall(probe: Probe): boolean
  /**
   * Já gravando: a call continua? Pode ser mais frouxo que isInCall (os sinais que separam a sala
   * de espera só valem para começar). Sem ele, vale isInCall. Emenda 10.
   */
  stillInCall?(probe: Probe): boolean
  /** Fim imediato (tela de saída, estado 6/7). */
  endSignal(probe: Probe): EndReason | null
  /** Teams estado 4/5. */
  isOnHold?(probe: Probe): boolean
  /** Título, código, participantes, selfName. Melhor esforço; nunca lança. */
  readMeta(): Partial<CallMeta>
  /**
   * Emenda 18: liga a escuta passiva dos sinais de falante (canais de dados, resposta de uma
   * chamada de rede). Chamado uma vez na instalação, no document_start, antes da página.
   */
  installSpeakerSignals?(ctx: SpeakerSignalsContext): void
  /**
   * Emenda 18: quem fala agora entre os participantes remotos (nomes exibidos, ou chaves
   * provisórias com SPEAKER_KEY_PREFIX), e por qual sinal. Lista vazia: ninguém fala. null: o
   * adaptador não tem como dizer agora. Nunca lança, nunca clica nem abre nada na página.
   */
  readSpeakers?(probe: SpeakerProbe): SpeakerReading | null
  /** Emenda 18: nome de cada chave provisória que já dá para resolver. */
  speakerAliases?(): Record<string, string>
  /**
   * Emenda 20: diagnóstico da linha do tempo, só com números (nunca nomes), mandado no lote final e
   * gravado no falantes.json. null sem nada a dizer.
   */
  speakerDiagnostics?(): SpeakerDiagnostics | null
}
