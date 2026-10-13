// Contrato de mensagens entre todas as partes da extensão (ver docs/ARQUITETURA.md, "Protocolo").
//
//   MAIN world  <-- MessagePort { dir, msg } (aperto de mão pela janela) -->  relay (ISOLATED)
//   relay       <-- Port "gravador:sessao" (JSON, áudio em base64)    -->  service worker
//   offscreen   <-- Port "gravador:aba" (mesmo Up/Down de chunks)     -->  service worker
//   vigia (ISOLATED, topo) <-- Port "gravador:vigia" (VigiaUp/VigiaDown) -->  service worker
//   service worker <-- native messaging (HostReq/HostRes)             -->  helper Node
//   popup/options  <-- chrome.runtime.sendMessage (UiReq/UiRes)       -->  service worker
//
// Emenda 1 (vários perfis): a raiz das gravações mora no helper (config.json), não no perfil;
// as operações do helper não recebem `root`, e cada sessão tem um dono (profileId).
//
// O MAIN world e o relay importam daqui só tipos (`import type`). As constantes de runtime ficam
// em ./constants.ts, sem zod, para o bundle do MAIN world não carregar os schemas.
import { z } from './zod'
import { END_REASONS, MAX_SPEAKER_INTERVALS, SPEAKER_SOURCES, UI_LANGUAGES, VIGIA_MODOS, BRIDGE_ACK, BRIDGE_MARK, BRIDGE_OPEN, BRIDGE_READY, BRIDGE_VERSION, type PAGE_OUTPUT_QUERY } from './constants'
import { isAllowedEndpoint, type ApiTranscriptionConfig } from './api-transcription'
import type { Platform } from './hosts'
import type { TabAudioMode } from './volume'

export * from './constants'
export type { ApiTranscriptionConfig } from './api-transcription'
export type { Platform } from './hosts'
export type { TabAudioMode } from './volume'

// ---------------------------------------------------------------------------------------------
// Tipos de domínio
// ---------------------------------------------------------------------------------------------

// Platform ('meet' | 'teams') mora em ./hosts.ts, junto dos hosts de cada uma (Emenda 17).

/**
 * Plataforma de uma gravação (Emenda 7): as duas das calls e `outro` para o modo aba numa aba fora
 * dos hosts do Meet e do Teams (o plano B de uma plataforma que a captura na página não cobre).
 * Só o SW cria `outro`; o conteúdo das calls continua falando só `Platform`.
 */
export type RecordingPlatform = Platform | 'outro'

/** As quatro fontes de captura ("seams"). */
export type SeamId = 'receivers' | 'elements' | 'sources' | 'output'


/**
 * Motivo do fim de uma gravação. Os valores vão literalmente para `motivoFim` no info.json.
 * - saida-automatica: o vigia saiu da call sozinho (AC18).
 * - saiu-da-call: tela de saída do Meet, estado desconectado do Teams.
 * - call-encerrada: a plataforma encerrou (todos saíram, anfitrião encerrou, PC fechado sem volta).
 * - fora-da-call: os sinais de "em call" ficaram falsos por 15 s seguidos.
 * - aba-fechada: chrome.tabs.onRemoved.
 * - navegou: a aba saiu da URL da call.
 * - pagehide: o documento foi descarregado (recarregar, fechar, navegar).
 * - parado-pelo-usuario: botão parar do popup ou atalho do modo aba.
 * - interrompida: o Chrome, a aba ou o service worker caíram e a sessão foi recuperada depois.
 * - erro: falha da captura que impediu continuar.
 */
export type EndReason =
  | 'saida-automatica'
  | 'saiu-da-call'
  | 'call-encerrada'
  | 'fora-da-call'
  | 'aba-fechada'
  | 'navegou'
  | 'pagehide'
  | 'parado-pelo-usuario'
  | 'interrompida'
  | 'erro'


/** De onde veio o título gravado. */
export type TitleSource = 'dom' | 'titulo-da-aba' | 'codigo' | 'nenhum'

/** Dados da call lidos pelo adaptador (melhor esforço; nunca bloqueiam a gravação). */
export interface CallMeta {
  title: string
  titleSource: TitleSource
  /** Código curto (Meet: abc-defg-hij; Teams: dígitos de /meet/<n>). */
  code: string
  /** ID longo (Teams: 19:meeting_...@thread.v2). */
  meetingId: string
  url: string
  tabTitle: string
  participants: string[]
  selfName: string
  /**
   * Emenda 20 (Meet): de onde o próprio nome poderia vir, para conferir uma call em que ele não
   * apareceu. `roster`: achado na roster (campo 7) no space da call; `spaces`: quantos spaces a roster
   * mostrou; `domMarker`: o [data-self-name] apareceu alguma vez.
   */
  selfSignals: { roster: boolean; spaces: number; domMarker: boolean }
  /**
   * Emenda 20 (Meet): o que o elemento do título mostrou de mais forte na call (`ausente`, o
   * `codigo` da reunião ou `outro` texto), por qual seletor, e se a aba era só o código.
   */
  titleSignals: { element: 'ausente' | 'codigo' | 'outro'; selector: 'NeC6gb' | 'u6vdEc' | null; tabEqualsCode: boolean }
}

/** Medida de um seam no instante do diagnóstico. */
export interface SeamDiag {
  /** Quantas fontes (faixas ou streams) o seam tem ligadas no mixer. */
  sources: number
  /** Energia sem atraso, em dBFS (-Infinity vira -200 para caber em JSON). */
  dbfs: number
  /** Se teve fala (acima do limiar) no último 1 s. */
  speech: boolean
}

/** Diagnóstico periódico da captura (session:diag a cada 5 s). */
export interface CaptureDiag {
  at: number
  ctxState: AudioContextState | 'none'
  /** Seam escolhido no início e o selecionado agora. */
  initial: SeamId | null
  selected: SeamId | null
  /** Todas as trocas desde o início (lista acumulada, vira `captura.trocas`). */
  switches: SeamSwitch[]
  seams: Record<SeamId, SeamDiag>
  /** PCs registrados não fechados e quantos estão connected. */
  pcs: { open: number; connected: number }
  /** Faixas remotas de áudio vivas vistas nos receptores. */
  remoteAudioTracks: number
  /** Elementos de priming (crbug 40094084) criados por nós. */
  primed: number
  chunks: number
  bytes: number
  /** Desde o início da gravação, algum seam selecionado já teve fala? */
  everHadSpeech: boolean
  /** ms desde a última fala no seam selecionado (null se nunca). */
  silentForMs: number | null
  recorderState: RecordingState | 'none'
  /** Períodos em espera (Teams 4/5), lista acumulada; o último pode estar aberto (to = null). */
  holds: HoldPeriod[]
}

/** Troca de seam registrada pela arbitragem. */
export interface SeamSwitch {
  at: number
  from: SeamId | null
  to: SeamId
}

/** Período em espera (Teams estado 4/5). */
export interface HoldPeriod {
  from: number
  to: number | null
}

/** De onde veio um intervalo da linha do tempo dos falantes (Emenda 18). */
export type SpeakerSource = (typeof SPEAKER_SOURCES)[number]

/**
 * Um intervalo da linha do tempo dos falantes (Emenda 18), em ms desde o começo do áudio gravado
 * (já com o atraso do mixer, MIXER_DELAY_MS).
 * - `nome`: o nome exibido do participante; uma chave provisória (começa com SPEAKER_KEY_PREFIX)
 *   quando a plataforma ainda não disse o nome; vazio no intervalo do próprio usuário.
 * - `voce`: o próprio usuário falou (medido no microfone, que nunca é gravado).
 */
export interface SpeakerInterval {
  nome: string
  de: number
  ate: number
  fonte: SpeakerSource
  voce?: true
}

/** Lacuna conhecida na sequência de chunks. */
export interface ChunkGap {
  fromSeq: number
  toSeq: number
}

/**
 * Quando o vigia sai da call (Emenda 16, 0.3.1):
 * - `sozinho`: só quando você ficar sozinho;
 * - `proporcao`: a regra do script (restar até `fracao` do pico, numa call que chegou a
 *   `picoParaQueda`); é o que vale para quem tinha a configuração antes do modo existir;
 * - `quantidade`: restarem `quantidade` pessoas ou menos (contando você), numa call que já teve
 *   mais que isso.
 * Em todos, ficar sozinho depois de a call ter 2 ou mais sai na hora.
 */
export type VigiaModo = (typeof VIGIA_MODOS)[number]

/** Idioma da interface escolhido nas configurações (Emenda 19). */
export type UiLanguage = (typeof UI_LANGUAGES)[number]

/** A regra de saída do vigia: o modo e os seis números do script (Emenda 2). */
export interface VigiaCfg {
  modo: VigiaModo
  /** Modo `quantidade`: sai com até este número de pessoas, contando você (1 a 50). */
  quantidade: number
  /** Confere a cada N segundos. */
  intervaloSeg: number
  /** Em call de picoParaQueda+, sai quando sobrar <= fracao do pico... */
  fracao: number
  /** ...ou <= minimo pessoas, o que for maior. */
  minimo: number
  /** Abaixo deste pico, só sai quando ficar sozinho. */
  picoParaQueda: number
  /** Leituras seguidas abaixo do limite antes de sair (sozinho sai na hora). */
  confirmacoes: number
  /** Leituras sem a call para considerar que ela acabou (fecha a aba). */
  faltasParaFim: number
}

/**
 * Configurações por perfil do Chrome (chrome.storage.local). A raiz NÃO está aqui: ela é do
 * helper (get-config/set-root), vale para todos os perfis (Emenda 1).
 */
export interface Settings {
  /** UUID do perfil, gerado uma vez pelo SW (chave própria `profileId`, nunca sobrescrita). */
  profileId: string
  /** Nome livre do perfil ("Trabalho"): vai no info.json e vira a primeira pasta. Vazio: sem nível. */
  profileLabel: string
  autoMeet: boolean
  autoTeams: boolean
  /** Gravações mais curtas que isso são descartadas. */
  minSeconds: number
  /** AC18: sair e fechar a aba quando a call esvaziar (desligado por padrão). */
  autoLeave: boolean
  /** Mostrar o indicador do vigia na página enquanto autoLeave estiver ligado. */
  vigiaIndicador: boolean
  vigia: VigiaCfg
  /**
   * Emenda 19: idioma da interface. `auto` (o padrão, e o de toda configuração de antes da 0.4.1)
   * segue o idioma do Chrome; `pt_BR` e `en` valem para toda a extensão, menos o que vem do
   * manifesto e a pasta em Downloads.
   */
  language: UiLanguage
  /**
   * Emenda 21: motor de transcrição por API do provedor, com a chave do próprio usuário, rodando
   * dentro da extensão. POR PERFIL (diferente da transcrição do helper, que é global): mandar o
   * áudio da call para fora é decisão de cada empresa. Desligado por padrão. A CHAVE não está
   * aqui: ela tem armazenamento próprio (src/shared/api-key.ts).
   */
  apiTranscription: ApiTranscriptionConfig
}

/** Saída automática registrada no info.json (Emenda 2). */
export interface AutoLeaveInfo {
  motivo: string
  pico: number
  na: number | null
  /** ms (no registro) ou ISO (no info.json). */
  em: number
}

/** Item da lista "últimas gravações" (chrome.storage.local, chave `recent`, máximo 20). */
export interface RecentRecording {
  sessionId: string
  platform: RecordingPlatform
  kind: SessionKind
  title: string
  startedAt: number
  endedAt: number
  durationSeconds: number
  /** Caminho absoluto da pasta (helper) ou relativo à pasta de downloads (reserva). */
  path: string
  sink: SinkKind
  /** Reserva downloads: ID do chrome.downloads para o "Mostrar no Finder" (downloads.show). */
  downloadId?: number
  status: 'concluida' | 'interrompida'
}

export type SessionKind = 'pagina' | 'aba'
export type SinkKind = 'host' | 'downloads'
export type SessionStatus = 'gravando' | 'finalizando' | 'salva' | 'descartada' | 'interrompida'

/** Arquivo listado no info.json. */
export interface InfoFile {
  nome: string
  tipo: SessionKind
  bytes: number
  formato: string
  kbps: number
}

/** Conteúdo do info.json (escrito por último na pasta da call). */
export interface InfoJson {
  versao: 1
  /** ID interno da sessão (permite cruzar com o IndexedDB e com os logs). */
  sessao: string
  /** Nome do perfil do Chrome (profileLabel); null quando não foi preenchido. */
  perfil: string | null
  plataforma: RecordingPlatform
  titulo: string
  tituloFonte: TitleSource
  codigo: string
  idReuniao: string
  url: string
  tituloDaAba: string
  /** Emenda 20 (Meet): `CallMeta.titleSignals` com as chaves em português. */
  tituloSinais?: { elemento: 'ausente' | 'codigo' | 'outro'; seletor: 'NeC6gb' | 'u6vdEc' | null; abaIgualCodigo: boolean }
  inicio: string
  fim: string
  duracaoSegundos: number
  fuso: string
  participantes: string[]
  voce: string
  /** Emenda 20 (Meet): `CallMeta.selfSignals` com as chaves em português. */
  voceSinais?: { roster: boolean; espacos: number; marcadorDom: boolean }
  arquivos: InfoFile[]
  captura: {
    fonteInicial: SeamId | null
    fonteFinal: SeamId | null
    trocas: Array<{ em: string; de: SeamId | null; para: SeamId }>
    contextoAudio: CaptureDiag['ctxState']
    teveAudio: boolean
  }
  esperas: Array<{ de: string; ate: string | null }>
  lacunas: ChunkGap[]
  status: 'concluida' | 'interrompida'
  motivoFim: EndReason
  /** Presente quando o vigia saiu sozinho (motivoFim = saida-automatica). */
  saidaAutomatica?: { motivo: string; pico: number; na: number | null; em: string }
  extensao: string
  helper: string | null
  /**
   * Emenda 19: idioma escolhido nas configurações quando a gravação foi salva (o de `localeTag`). O
   * helper escreve o cabeçalho do transcricao.md nele. Sem o campo (idioma em Automático, ou
   * info.json de antes da 0.4.1), em português, como antes.
   */
  idiomaInterface?: InfoLanguage
  /**
   * Emenda 18: resumo da linha do tempo dos falantes (a linha inteira fica em falantes.json). Só
   * existe quando a plataforma disse quem falou (algum intervalo de participante).
   */
  falantes?: InfoSpeakers
  /**
   * Escrito pelo helper e pelo worker da transcrição (Emenda 13), nunca pela extensão: o estado do
   * áudio principal (o último posto na fila, como o do modo aba que entrou na pasta da página).
   */
  transcricao?: InfoTranscription
  /** Estado da transcrição de cada áudio da pasta, pelo nome do arquivo (audio.webm, audio-aba.webm). */
  transcricoes?: Record<string, InfoTranscription>
}

/** Idiomas do `idiomaInterface` do info.json (Emenda 19): a mensagem `localeTag` de cada língua. */
export type InfoLanguage = 'pt-BR' | 'en'

/** Resumo dos falantes no info.json (Emenda 18). */
export interface InfoSpeakers {
  arquivo: string
  /**
   * Quem falou e por quanto tempo (segundos, uma casa), na ordem da primeira fala. `semNome`
   * (Emenda 20): a plataforma não disse o nome, e o rótulo é nosso ("Participante N").
   */
  pessoas: Array<{ nome: string; segundos: number; voce?: true; semNome?: true }>
  /** Fontes que deram algum intervalo (csrc, dcrpc, dsh, dom, microfone). */
  fontes: SpeakerSource[]
}

/** falantes.json na pasta da call (Emenda 18): a linha do tempo inteira, lida pela transcrição. */
export interface SpeakersFile {
  versao: 1
  /** Os tempos são ms desde o começo deste áudio. */
  audio: string
  /** Atraso do mixer já somado a cada intervalo (o áudio gravado sai atrasado). */
  atrasoMs: number
  intervalos: SpeakerInterval[]
  pessoas: InfoSpeakers['pessoas']
  /** Textos que a transcrição escreve, no idioma da interface. */
  textos: { voceNaoGravada: string }
  /**
   * Emenda 20: fontes sem nome que acompanhavam quem fala e saíram da linha do tempo (não eram
   * pessoas). Só existe quando alguma saiu. Diagnóstico sem nome de ninguém.
   */
  descartadas?: SpeakerDropped[]
  /** Emenda 20: o diagnóstico que a página mandou no fim (só números). */
  diagnostico?: SpeakerDiagnostics
}

/**
 * Diagnóstico da linha do tempo (Emenda 20), só com números, para conferir numa call real o que os
 * testes não provam. `csrc` (Meet): quantos receptores mandaram CSRC e, por CSRC ativo (até 32, os
 * mais lidos), em quantas leituras ficou ativo, em quantos receptores apareceu, se a roster o
 * resolveu, em quantas leituras estava no mesmo pacote de uma pessoa com nome, e por que foi
 * ignorado (`mais-alto`: o CSRC 42; `roster`: o próprio usuário, uma apresentação ou outra call).
 */
export interface SpeakerDiagnostics {
  csrc?: {
    receptores: number
    fontes: Array<{ csrc: number; leiturasAtiva: number; receptores: number; resolvida: boolean; mesmoPacoteComNomeada: number; ignorada?: 'mais-alto' | 'roster' }>
  }
}

/** Uma fonte sem nome que saiu da linha do tempo (Emenda 20, `UNNAMED_SHADOW` em speakers.ts). */
export interface SpeakerDropped {
  /** A chave provisória sem o prefixo: o tipo e o id da plataforma ("csrc:42", "dev:<id>"). */
  chave: string
  segundos: number
  /** Do tempo ativo dela, quanto teve alguma pessoa nomeada falando junto (%, uma casa). */
  coberturaPct: number
  /** Do tempo em que as pessoas nomeadas falaram, quanto ela esteve ativa junto (%, uma casa). */
  presencaPct: number
  /** Quantas pessoas nomeadas diferentes ela acompanhou. */
  pessoasCobertas: number
}

// ---------------------------------------------------------------------------------------------
// Transcrição (Emenda 13): mora no helper (config.json, fila, worker), como a raiz
// ---------------------------------------------------------------------------------------------

/** Seção `transcricao` do config.json do helper (vale para todos os perfis). */
export interface TranscriptionConfig {
  /** Transcrever sozinho ao fim de cada call salva pelo helper. */
  ativa: boolean
  /** Motor (host/transcricao.mjs, ENGINES). Hoje só `whisper-cpp`. */
  motor: string
  /** Caminho do modelo; vazio: o helper procura nas pastas comuns. */
  modelo: string
  /** `auto` ou um código de idioma (pt, en...). */
  idioma: string
  /** Caminhos dos programas; vazio: PATH, /opt/homebrew/bin, /usr/local/bin. */
  whisperCli: string
  ffmpeg: string
}

export type TranscriptionStatus = 'pendente' | 'transcrevendo' | 'pronta' | 'falhou'

/** `transcricao` no info.json da pasta da call. */
export interface InfoTranscription {
  status: TranscriptionStatus
  motor: string
  modelo: string | null
  idioma: string
  /** Arquivo de áudio transcrito (audio.webm da página ou audio-aba.webm do modo aba). */
  audio?: string
  inicio: string | null
  fim: string | null
  duracaoProcessamentoSeg: number | null
  /** transcricao.md e .srt (audio.webm) ou transcricao-aba.md e .srt (audio-aba.webm). */
  arquivos: string[]
  /** Motivo da falha, em português (status `falhou`). */
  erro?: string
  /** Por que ainda não começou (status `pendente`): falta o whisper, o ffmpeg ou o modelo. */
  espera?: string
}

/** Motor que o helper conhece, com o rótulo das telas. */
export interface TranscriptionEngineInfo {
  id: string
  rotulo: string
}

/** Resposta do helper a transcription-status. */
export interface HostTranscriptionStatusOk {
  ativa: boolean
  motor: string
  idioma: string
  disponivel: boolean
  motivo: string | null
  detalhes: { whisperCli?: string | null; ffmpeg?: string | null; modelo?: string | null }
  modeloEncontrado: string | null
  /** O worker está rodando agora. */
  trabalhando: boolean
  fila: Array<{ id: string; pasta: string; audio: string; estado: string; criadoEm: string }>
  recentes: Array<{ path: string; transcricao: InfoTranscription | null }>
}

/**
 * info.json de um staging órfão do helper (Emenda 7): sobrou na raiz sem registro no IndexedDB
 * (src/background/sessions.ts, finalizeOrphan). Sem registro não se sabe plataforma, título,
 * participantes nem captura: o arquivo diz só o que há, e `semRegistro` avisa quem lê.
 */
export interface OrphanInfoJson {
  versao: 1
  sessao: string
  perfil: string | null
  plataforma: null
  titulo: string
  semRegistro: true
  inicio: string
  fim: string
  duracaoSegundos: number
  fuso: string
  arquivos: InfoFile[]
  lacunas: ChunkGap[]
  status: 'interrompida'
  motivoFim: 'interrompida'
  extensao: string
  helper: string | null
}

// ---------------------------------------------------------------------------------------------
// Conteúdo -> SW (Port gravador:sessao) e offscreen -> SW (Port gravador:aba)
// ---------------------------------------------------------------------------------------------

export type Up =
  | { t: 'hello'; frameUrl: string; isTop: boolean; platform: Platform | null; hookVersion: string; hookedAt: number }
  | { t: 'session:start'; localId: string; platform: Platform; startedAt: number; meta: Partial<CallMeta> }
  | { t: 'session:resume'; localId: string; sessionId: string; nextSeq: number }
  | { t: 'session:chunk'; sessionId: string; seq: number; data: string; bytes: number; at: number }
  | { t: 'session:meta'; sessionId: string; meta: Partial<CallMeta> }
  | { t: 'session:diag'; sessionId: string; diag: CaptureDiag }
  /**
   * Emenda 18: intervalos da linha do tempo dos falantes a partir do índice `from` (o SW troca tudo
   * de `from` em diante por estes). `aliases`: nome de cada chave provisória já resolvida.
   */
  | { t: 'session:speakers'; sessionId: string; from: number; intervals: SpeakerInterval[]; aliases?: Record<string, string>; diagnostico?: SpeakerDiagnostics }
  | { t: 'session:end'; sessionId: string; endedAt: number; reason: EndReason; lastSeq: number }

export type UpType = Up['t']

// ---------------------------------------------------------------------------------------------
// SW -> conteúdo
// ---------------------------------------------------------------------------------------------

/** `no-consent`: o aviso da primeira execução ainda não foi confirmado (Emenda 15). */
export type RejectReason = 'disabled' | 'no-consent' | 'other-frame' | 'other'

export type Down =
  | { t: 'session:accepted'; localId: string; sessionId: string }
  | { t: 'session:rejected'; localId: string; reason: RejectReason }
  | { t: 'chunk:ack'; sessionId: string; seq: number }
  | { t: 'session:stop'; sessionId: string; reason: 'user' }
  | { t: 'settings'; autoMeet: boolean; autoTeams: boolean }

export type DownType = Down['t']

/**
 * Ponte MAIN <-> ISOLATED (src/main-world/bridge.ts). Pela janela só passa o aperto de mão; o
 * tráfego vai pelo MessagePort transferido no open, que a página não vê.
 */
export type BridgeHandshake =
  | { [BRIDGE_MARK]: typeof BRIDGE_VERSION; dir: 'down'; t: typeof BRIDGE_READY }
  | { [BRIDGE_MARK]: typeof BRIDGE_VERSION; dir: 'up'; t: typeof BRIDGE_OPEN }
export type BridgePortMessage = { t: typeof BRIDGE_ACK } | { dir: 'up'; msg: Up } | { dir: 'down'; msg: Down }

// ---------------------------------------------------------------------------------------------
// SW <-> helper (native messaging, 4 bytes LE de tamanho + JSON)
// ---------------------------------------------------------------------------------------------

export type HostReq =
  /** Versão, raiz atual e se dá para gravar nela. */
  | { id: number; op: 'ping' }
  | { id: number; op: 'get-config' }
  /** Valida, cria se não existir e grava no config.json (vale para todos os perfis). */
  | { id: number; op: 'set-root'; path: string }
  /** Só valida um caminho candidato. */
  | { id: number; op: 'check-root'; path: string }
  | { id: number; op: 'choose-folder'; prompt: string }
  /** Cria <root>/.gravando/<sessionId>/ com owner.json (o dono é o profileId). */
  | { id: number; op: 'begin'; sessionId: string; owner: string }
  | { id: number; op: 'append'; sessionId: string; file: string; seq: number; data: string }
  /**
   * Reserva <root>/<relDir> com mkdir NÃO recursivo do último nível (EEXIST: tenta " (2)",
   * " (3)"...), move os arquivos para dentro e escreve info.json por último. Extensão desta
   * fatia: com `merge: true`, se a pasta já existe, os arquivos entram nela (modo aba junto da
   * gravação de página) e info.json, se vier, substitui o que estiver lá.
   */
  /**
   * `extras` (Emenda 18): arquivos de texto escritos na pasta antes do info.json; o helper só aceita
   * os nomes que conhece (falantes.json).
   */
  /**
   * `semTranscricao` (Emenda 21): não ponha esta pasta na fila do motor local. A extensão manda
   * quando o motor por API está ligado neste perfil, para os dois motores não transcreverem a
   * mesma pasta. Um helper anterior ignora o campo, e por isso a extensão exige o helper 0.5.0
   * para ligar o motor por API quando há helper instalado.
   */
  | { id: number; op: 'finalize'; sessionId: string; relDir: string; info: InfoJson | OrphanInfoJson | null; merge?: boolean; extras?: HostExtraFile[]; semTranscricao?: boolean }
  | { id: number; op: 'discard'; sessionId: string }
  /** Só as sessões deste dono (a recuperação de um perfil nunca toca nas de outro). */
  | { id: number; op: 'list-staging'; owner: string }
  | { id: number; op: 'reveal'; path: string }
  /** Emenda 13: muda a seção `transcricao` do config.json (o helper valida cada campo). */
  | { id: number; op: 'set-transcription'; patch: Partial<TranscriptionConfig> }
  /** Disponibilidade, fila e o estado da transcrição de cada pasta em `paths`. */
  | { id: number; op: 'transcription-status'; paths?: string[] }
  /** Abre transcricao.md/.srt com o aplicativo padrão (só dentro da raiz). */
  | { id: number; op: 'open-file'; path: string }
  /** Seletor de arquivo do macOS (o modelo do whisper). */
  | { id: number; op: 'choose-file'; prompt: string }
  /**
   * Emenda 21: escreve os arquivos de uma transcrição feita pela extensão (motor por API) na pasta
   * da call e grava o estado em `info.json.transcricao`, pelo mesmo caminho do worker do motor
   * local. O helper confere que a pasta está dentro de uma raiz conhecida e que cada nome é
   * `transcricao*.md` ou `.srt`, como no `open-file`.
   */
  | { id: number; op: 'transcription-write'; path: string; audio: string; arquivos: HostExtraFile[]; transcricao?: InfoTranscription }

/** Arquivo de texto a mais no finalize (Emenda 18) e na escrita da transcrição (Emenda 21). */
export interface HostExtraFile {
  nome: string
  texto: string
}

export type HostOp = HostReq['op']
/** Requisição sem o id (quem numera é o cliente). */
export type HostRequest = HostReq extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export type HostRes =
  | { id: number; ok: true; [k: string]: unknown }
  | { id: number; ok: false; error: string; expected?: number }

/** Respostas de sucesso conhecidas (campos extras de cada op). */
export interface HostPingOk {
  version: string
  node: string
  platform: string
  /** Raiz atual (absoluta) e se dá para gravar nela. */
  root: string
  writable: boolean
  configPath: string
}
export interface HostConfigOk {
  root: string
  configPath: string
  /** Emenda 13 (ausentes num helper de antes da 0.2.0). */
  transcricao?: TranscriptionConfig
  motores?: TranscriptionEngineInfo[]
}
export interface HostCheckRootOk {
  root: string
  writable: true
}
export interface HostAppendOk {
  nextSeq: number
  bytes: number
}
export interface HostFinalizeOk {
  path: string
}
export interface HostStagingEntry {
  sessionId: string
  owner: string
  files: Array<{ file: string; bytes: number; nextSeq: number }>
  /** ms do begin e da última escrita (Emenda 7): a recuperação de órfãos usa o tempo parado. */
  createdAt?: number
  updatedAt?: number
}

// ---------------------------------------------------------------------------------------------
// popup/options -> SW (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------------------------

/** Gravação em andamento, como o popup mostra. */
export interface ActiveRecording {
  sessionId: string
  tabId: number
  kind: SessionKind
  platform: RecordingPlatform
  title: string
  startedAt: number
  /** Chegou áudio (fala) em algum momento? */
  hasAudio: boolean
  /**
   * Está chegando áudio agora? Fala no seam selecionado há no máximo AUDIO_NOW_MS (10 s),
   * contando a idade do último session:diag (Emenda 6). Sem diagnóstico ainda: false.
   */
  audioNow: boolean
  /**
   * ms desde a última fala no seam selecionado, já somada a idade do último diagnóstico (null:
   * nunca houve fala ou ainda não chegou diagnóstico).
   */
  silentForMs: number | null
  /** ms desde o último chunk recebido. */
  lastChunkAgoMs: number | null
  bytes: number
  /** Estado do vigia naquela aba (null: desligado ou sem leitura ainda). */
  vigia: VigiaStatus | null
  /**
   * Só no modo aba: o som capturado está sendo devolvido à saída padrão? Fica desligado quando a
   * página toca num dispositivo de saída específico (o Chrome não silencia esse caminho e o
   * usuário ouviria em dobro). Emenda 11.
   */
  replay?: boolean
}

/** Gravação que terminou e ainda não foi salva (a recuperação tenta de novo). Emenda 10. */
export interface PendingSave {
  sessionId: string
  tabId: number
  kind: SessionKind
  platform: RecordingPlatform
  title: string
  startedAt: number
  /** Motivo da última tentativa. */
  error: string
}

export interface HelperStatus {
  ok: boolean
  version: string | null
  /** Raiz atual no helper (null sem helper). */
  root: string | null
  writable: boolean
  error: string | null
}

export type UiReq =
  | { t: 'ui:state' }
  | { t: 'ui:stop'; sessionId: string }
  /** "Mostrar no Finder" de uma das últimas gravações: o SW escolhe helper ou downloads. */
  | { t: 'ui:reveal'; sessionId: string }
  | { t: 'ui:tab-capture'; tabId: number }
  /** Liga ou desliga a devolução do som no modo aba daquela aba (Emenda 11). */
  | { t: 'ui:tab-replay'; tabId: number; on: boolean }
  | { t: 'ui:choose-folder' }
  | { t: 'ui:check-root'; path: string }
  | { t: 'ui:set-root'; path: string }
  /** Salva as configurações do perfil (profileId é ignorado: ele nunca muda). */
  | { t: 'ui:save-settings'; settings: Omit<Settings, 'profileId'> }
  /** Vigia da aba (o popup abre sobre uma aba; vale mesmo sem gravação). Emenda 6. */
  | { t: 'ui:vigia-status'; tabId: number }
  /** "Sair agora" e "Desligar nesta call" (respondidos por src/background/vigia.ts). */
  | { t: 'ui:vigia-sair-agora'; tabId: number }
  | { t: 'ui:vigia-desligar'; tabId: number }
  /** "Tentar agora" das gravações que não foram salvas: roda a recuperação (Emenda 10). */
  | { t: 'ui:retry-saves' }
  /** Volume desta aba (Emenda 14): o valor atual e se há captura da extensão nela. */
  | { t: 'ui:tab-volume-get'; tabId: number }
  /** Volume desta aba, fator de 0 a 2 (o SW limita). Nunca mexe em gravação. */
  | { t: 'ui:tab-volume-set'; tabId: number; volume: number }
  /** Emenda 13: configuração e disponibilidade da transcrição (configurações). */
  | { t: 'ui:transcription' }
  | { t: 'ui:set-transcription'; patch: Partial<TranscriptionConfig> }
  /** "Abrir transcrição" de uma das últimas gravações. */
  | { t: 'ui:open-transcript'; sessionId: string }
  /** "Escolher..." do modelo (seletor de arquivo do macOS pelo helper). */
  | { t: 'ui:choose-model' }

/** Estado da transcrição de uma das últimas gravações, como o popup mostra (Emenda 13). */
export interface RecentTranscription {
  status: TranscriptionStatus
  erro?: string
  /** Na fila esperando o motor (whisper, ffmpeg ou modelo faltando), com o motivo. */
  espera?: string
  /** Caminho do .md da transcrição (status `pronta`): transcricao.md ou transcricao-aba.md. */
  arquivo?: string
  /**
   * Emenda 21: o chrome.downloads do .md quando a gravação (e a transcrição por API) caiu em
   * Downloads. Sem o helper não há como abrir um arquivo com o aplicativo padrão, então o
   * "Abrir transcrição" mostra o arquivo no Finder.
   */
  downloadId?: number
}

/**
 * Transcrição no popup (Emenda 13). null: sem helper (as gravações vão para Downloads e não são
 * transcritas).
 */
export interface TranscriptionUiState {
  /** O helper respondeu à transcrição (um helper de antes da 0.2.0 não conhece a operação). */
  suportada: boolean
  ativa: boolean
  disponivel: boolean
  motivo: string | null
  /** Por sessionId das últimas gravações salvas pelo helper. */
  porSessao: Record<string, RecentTranscription>
  /**
   * Emenda 21: qual motor vale neste perfil. `api` significa que as gravações em Downloads TAMBÉM
   * são transcritas, então a linha "a transcrição precisa do helper" não vale mais para elas.
   */
  motor?: 'local' | 'api'
}

/** O que as configurações mostram e editam da transcrição (ui:transcription). */
export interface TranscriptionSettingsState {
  config: TranscriptionConfig
  motores: TranscriptionEngineInfo[]
  disponivel: boolean
  motivo: string | null
  detalhes: HostTranscriptionStatusOk['detalhes']
}

export interface UiState {
  active: ActiveRecording[]
  recent: RecentRecording[]
  helper: HelperStatus
  settings: Settings
  /** Vigia por aba de call aberta (mesmo sem gravação). */
  vigia: Array<{ tabId: number; status: VigiaStatus }>
  /** Abas de call marcadas com ↻ (abertas antes da instalação ou atualização). Emenda 10. */
  reloadTabs: number[]
  /** Gravações que não foram salvas ainda (Emenda 10). */
  pendingSaves: PendingSave[]
  /** Emenda 13. */
  transcription: TranscriptionUiState | null
  /** O aviso da primeira execução foi confirmado neste perfil (Emenda 15). */
  consentGiven: boolean
  /**
   * Versão e build embutidos no código do SW (Emenda 17). Ausente num SW anterior à 0.3.1: o popup
   * e as configurações tratam a falta como "versão anterior".
   */
  worker?: BuildInfo
  /** Publicação mais nova que o SW e o que segura a recarga sozinha (Emenda 17; null: em dia ou loja). */
  update?: AutoReloadState | null
}

/** Versão do package.json e identificador do build (scripts/build-info.mjs), embutidos em cada bundle. Emenda 17. */
export interface BuildInfo {
  version: string
  build: string
}

/** O que impede a recarga sozinha agora (Emenda 17). */
export type AutoReloadWait = 'gravando' | 'salvando' | 'call-aberta' | 'volume' | 'iniciando-captura' | 'configuracoes-abertas'

/** Estado da recarga sozinha visto pelo SW (Emenda 17). */
export interface AutoReloadState {
  /** A versão publicada (publicado.json) que o SW ainda não está rodando. */
  published: BuildInfo
  /** O que segura a recarga agora (vazio: vai recarregar). */
  waiting: AutoReloadWait[]
  /** Já recarregou uma vez para esta publicação e o código continuou o anterior: não tenta mais. */
  gaveUp: boolean
}

/** Resposta de cada UiReq. */
export interface UiResMap {
  'ui:state': UiState
  'ui:stop': { ok: boolean }
  'ui:reveal': { ok: boolean; error?: string }
  'ui:tab-capture': { ok: boolean; error?: string }
  'ui:tab-replay': { ok: boolean; error?: string }
  'ui:choose-folder': { ok: boolean; path?: string; error?: string }
  'ui:check-root': { ok: boolean; root?: string; error?: string }
  'ui:set-root': { ok: boolean; root?: string; error?: string }
  'ui:save-settings': { ok: boolean; error?: string }
  'ui:vigia-status': VigiaTabState
  'ui:vigia-sair-agora': { ok: boolean; error?: string }
  'ui:vigia-desligar': { ok: boolean; error?: string }
  'ui:retry-saves': { ok: boolean; pending: number }
  'ui:tab-volume-get': TabVolumeState
  'ui:tab-volume-set': { ok: boolean; error?: string } & Partial<TabVolumeState>
  'ui:transcription': { ok: true; state: TranscriptionSettingsState } | { ok: false; error: string }
  'ui:set-transcription': { ok: boolean; config?: TranscriptionConfig; error?: string }
  'ui:open-transcript': { ok: boolean; error?: string }
  'ui:choose-model': { ok: boolean; path?: string; error?: string }
}

/**
 * Volume de uma aba visto pelo popup (Emenda 14). `active`: a extensão captura a aba agora (só
 * volume ou modo aba); `mode` diz qual.
 */
export interface TabVolumeState {
  volume: number
  active: boolean
  mode: TabAudioMode | null
}

// ---------------------------------------------------------------------------------------------
// vigia (ISOLATED, frame do topo) <-> SW (Port gravador:vigia), Emendas 2 e 3
// ---------------------------------------------------------------------------------------------

export interface VigiaStatus {
  /** Plataforma da aba (o popup mostra a fonte da contagem conforme a plataforma). */
  platform: Platform
  naCall: boolean
  /** Quantos na call (null: leitura falhou, não zera nem conta). */
  n: number | null
  /** De onde veio a contagem ("botão de pessoas", "painel de pessoas", ...). */
  fonte: string | null
  pico: number
  limite: number
  armado: boolean
  seguidas: number
  saindo: boolean
  tentativas: number
}

/** O que o popup sabe do vigia de uma aba (ui:vigia-status, Emenda 6). */
export interface VigiaTabState {
  /** O content script do vigia desta aba está conectado (autoLeave ligado, página de call). */
  connected: boolean
  /**
   * O vigia está parado nesta call: "Desligar nesta call" foi pedido, ou ele desistiu de sair
   * (Meet sem botão seguro). Vale até a próxima call da aba, mesmo sem recarregar (Emenda 7).
   */
  disabledForCall: boolean
  /** Última leitura (null: ainda sem leitura). */
  status: VigiaStatus | null
}

export type VigiaUp =
  | ({ t: 'vigia:status' } & VigiaStatus)
  /** Mandado ANTES do primeiro clique em sair. */
  | { t: 'vigia:saindo'; motivo: string; pico: number; n: number | null }
  /** No lugar do window.close() do script: o SW fecha depois de salvar (até 20 s). */
  | { t: 'vigia:fechar-aba'; motivo: 'saiu-da-call' | 'a-call-acabou' }
  /** Meet: o diálogo do organizador não tinha um "só sair" seguro; não clicou e avisa. */
  | { t: 'vigia:nao-consegui-sair'; motivo: string }
  /**
   * Emenda 7: o vigia está desligado nesta call (pelo popup ou porque desistiu de sair) ou voltou
   * a valer numa call nova do mesmo documento. Mandado ao conectar e a cada mudança; o SW espelha
   * em `VigiaTabState.disabledForCall`, então a verdade fica no content script.
   */
  | { t: 'vigia:nesta-call'; desligado: boolean }

export type VigiaDown =
  | { t: 'vigia:config'; autoLeave: boolean; indicador: boolean; cfg: VigiaCfg }
  | { t: 'vigia:sair-agora' }
  | { t: 'vigia:desligar-nesta-call' }

// ---------------------------------------------------------------------------------------------
// SW -> offscreen (chrome.runtime.sendMessage com `target: 'offscreen'`)
// ---------------------------------------------------------------------------------------------

export type OffscreenReq =
  | { target: 'offscreen'; t: 'offscreen:blob-url'; sessionId: string; mime: string }
  /** Emenda 21: Blob de um texto (transcricao.md, .srt) para a reserva de Downloads. */
  | { target: 'offscreen'; t: 'offscreen:text-url'; texto: string; mime: string }
  | { target: 'offscreen'; t: 'offscreen:revoke'; url: string }
  /**
   * `replay`: devolve o som capturado à saída padrão (Emenda 11). Sem `streamId`, reaproveita a
   * captura só de volume que a aba já tem (Emenda 14: o Chrome só deixa uma captura por aba).
   */
  | { target: 'offscreen'; t: 'offscreen:tab-start'; tabId: number; streamId?: string; sessionId: string; replay: boolean }
  | { target: 'offscreen'; t: 'offscreen:tab-replay'; tabId: number; on: boolean }
  /** `reason` vai no session:end que o offscreen manda (sem ele, parado pelo usuário). */
  | { target: 'offscreen'; t: 'offscreen:tab-stop'; tabId: number; reason?: EndReason }
  /** Emenda 14: captura só de volume (sem gravador). */
  | { target: 'offscreen'; t: 'offscreen:tab-volume-start'; tabId: number; streamId: string; volume: number }
  /** Muda o volume da captura da aba, só de volume ou gravando (nunca para nada). */
  | { target: 'offscreen'; t: 'offscreen:tab-volume'; tabId: number; volume: number }
  /** Desfaz a captura só de volume. Não toca numa captura que está gravando. */
  | { target: 'offscreen'; t: 'offscreen:tab-volume-stop'; tabId: number }
  /** Estado da captura da aba no offscreen (o SW reinicia e perde a memória; o offscreen não). */
  | { target: 'offscreen'; t: 'offscreen:tab-audio'; tabId: number }
  /** Versão e build embutidos no documento offscreen (Emenda 17): ele é lido do disco ao abrir. */
  | { target: 'offscreen'; t: 'offscreen:version' }

export interface OffscreenResMap {
  'offscreen:blob-url': { ok: boolean; url?: string; bytes?: number; error?: string }
  'offscreen:text-url': { ok: boolean; url?: string; bytes?: number; error?: string }
  'offscreen:revoke': { ok: boolean }
  'offscreen:tab-start': { ok: boolean; error?: string }
  'offscreen:tab-stop': { ok: boolean }
  'offscreen:tab-replay': { ok: boolean }
  'offscreen:tab-volume-start': { ok: boolean; error?: string }
  'offscreen:tab-volume': { ok: boolean }
  'offscreen:tab-volume-stop': { ok: boolean }
  'offscreen:tab-audio': TabAudioState
  'offscreen:version': BuildInfo
}

/** Captura de uma aba no offscreen (Emenda 14). `gain` é o ganho que se ouve agora. */
export interface TabAudioState {
  mode: TabAudioMode | null
  volume: number
  replay: boolean
  gain: number
}

/**
 * SW -> relay da frame do topo (chrome.tabs.sendMessage): a página toca o som num dispositivo de
 * saída específico (`sinkId` não vazio)? Usado antes do modo aba (Emenda 11). A constante
 * `PAGE_OUTPUT_QUERY` mora em ./constants.ts (o relay a usa sem carregar o zod).
 */
export interface PageOutputQuery {
  t: typeof PAGE_OUTPUT_QUERY
}
export interface PageOutputAnswer {
  especifica: boolean
}

// ---------------------------------------------------------------------------------------------
// Schemas zod (usados pelo SW para validar tudo o que chega dos Ports)
// ---------------------------------------------------------------------------------------------

const platformSchema = z.enum(['meet', 'teams'])
const seamSchema = z.enum(['receivers', 'elements', 'sources', 'output'])
const endReasonSchema = z.enum(END_REASONS)
const nonNegInt = z.number().int().nonnegative()
const time = z.number().finite().nonnegative()

export const callMetaSchema = z
  .object({
    title: z.string().max(1000),
    titleSource: z.enum(['dom', 'titulo-da-aba', 'codigo', 'nenhum']),
    code: z.string().max(200),
    meetingId: z.string().max(500),
    url: z.string().max(4000),
    tabTitle: z.string().max(1000),
    participants: z.array(z.string().max(300)).max(1000),
    selfName: z.string().max(300),
    selfSignals: z.object({ roster: z.boolean(), spaces: nonNegInt.max(10_000), domMarker: z.boolean() }),
    titleSignals: z.object({ element: z.enum(['ausente', 'codigo', 'outro']), selector: z.enum(['NeC6gb', 'u6vdEc']).nullable(), tabEqualsCode: z.boolean() }),
  })
  .partial()

const seamDiagSchema = z.object({ sources: nonNegInt, dbfs: z.number(), speech: z.boolean() })

export const captureDiagSchema = z.object({
  at: time,
  ctxState: z.enum(['suspended', 'running', 'closed', 'interrupted', 'none']),
  initial: seamSchema.nullable(),
  selected: seamSchema.nullable(),
  switches: z.array(z.object({ at: time, from: seamSchema.nullable(), to: seamSchema })).max(10000),
  seams: z.object({
    receivers: seamDiagSchema,
    elements: seamDiagSchema,
    sources: seamDiagSchema,
    output: seamDiagSchema,
  }),
  pcs: z.object({ open: nonNegInt, connected: nonNegInt }),
  remoteAudioTracks: nonNegInt,
  primed: nonNegInt,
  chunks: nonNegInt,
  bytes: nonNegInt,
  everHadSpeech: z.boolean(),
  silentForMs: z.number().nonnegative().nullable(),
  recorderState: z.enum(['inactive', 'recording', 'paused', 'none']),
  holds: z.array(z.object({ from: time, to: time.nullable() })).max(10000),
})

const sessionIdSchema = z.string().min(1).max(100)

export const speakerIntervalSchema = z
  .object({
    nome: z.string().max(300),
    de: time,
    ate: time,
    fonte: z.enum(SPEAKER_SOURCES),
    voce: z.literal(true).optional(),
  })
  .refine((i) => i.ate >= i.de, { message: 'intervalo que termina antes de começar' })

/**
 * Diagnóstico dos falantes (Emenda 20). Só os campos numéricos conhecidos passam: o zod descarta
 * qualquer chave a mais (um nome, por exemplo) sem recusar o lote, que leva a linha do tempo inteira.
 */
const speakerDiagnosticsSchema = z.object({
  csrc: z
    .object({
      receptores: nonNegInt.max(100_000),
      fontes: z
        .array(
          z.object({
            csrc: nonNegInt.max(0xffffffff),
            leiturasAtiva: nonNegInt,
            receptores: nonNegInt.max(100_000),
            resolvida: z.boolean(),
            mesmoPacoteComNomeada: nonNegInt,
            ignorada: z.enum(['mais-alto', 'roster']).optional(),
          }),
        )
        .max(32),
    })
    .optional(),
})

export const upSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    frameUrl: z.string().max(4000),
    isTop: z.boolean(),
    platform: platformSchema.nullable(),
    hookVersion: z.string().max(50),
    hookedAt: time,
  }),
  z.object({
    t: z.literal('session:start'),
    localId: z.string().min(1).max(100),
    platform: platformSchema,
    startedAt: time,
    meta: callMetaSchema,
  }),
  z.object({
    t: z.literal('session:resume'),
    localId: z.string().min(1).max(100),
    sessionId: sessionIdSchema,
    nextSeq: nonNegInt,
  }),
  z.object({
    t: z.literal('session:chunk'),
    sessionId: sessionIdSchema,
    seq: nonNegInt,
    // 5 s a 32 kbps dão ~20 KB; o limite folgado protege contra lixo.
    data: z.string().max(16 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/),
    bytes: nonNegInt,
    at: time,
  }),
  z.object({ t: z.literal('session:meta'), sessionId: sessionIdSchema, meta: callMetaSchema }),
  z.object({ t: z.literal('session:diag'), sessionId: sessionIdSchema, diag: captureDiagSchema }),
  z.object({
    t: z.literal('session:speakers'),
    sessionId: sessionIdSchema,
    from: nonNegInt.max(MAX_SPEAKER_INTERVALS),
    intervals: z.array(speakerIntervalSchema).max(MAX_SPEAKER_INTERVALS),
    aliases: z
      .record(z.string().max(300), z.string().max(300))
      .refine((r) => Object.keys(r).length <= 1000, { message: 'aliases demais' })
      .optional(),
    diagnostico: speakerDiagnosticsSchema.optional(),
  }),
  z.object({
    t: z.literal('session:end'),
    sessionId: sessionIdSchema,
    endedAt: time,
    reason: endReasonSchema,
    lastSeq: z.number().int().min(-1),
  }),
])

/**
 * Os seis números do vigia. Emenda 10: a regra da queda nunca pode sair de uma call no pico (sem
 * ninguém ter saído), ou seja, limite(p) = max(minimo, floor(p * fracao)) < p para todo p a partir
 * de picoParaQueda: minimo < picoParaQueda e fracao < 1.
 */
export const vigiaCfgSchema = z
  .object({
    modo: z.enum(VIGIA_MODOS),
    quantidade: z.number().int().min(1).max(50),
    intervaloSeg: z.number().min(1).max(600),
    fracao: z.number().min(0).max(1),
    minimo: z.number().int().min(1).max(1000),
    picoParaQueda: z.number().int().min(1).max(1000),
    confirmacoes: z.number().int().min(1).max(100),
    faltasParaFim: z.number().int().min(1).max(100),
  })
  .superRefine((v, ctx) => {
    if (v.fracao >= 1) ctx.addIssue({ code: 'custom', path: ['fracao'], message: 'use uma fração menor que 1 (com 1, sairia sem ninguém ter saído)' })
    if (v.minimo >= v.picoParaQueda) {
      ctx.addIssue({ code: 'custom', path: ['picoParaQueda'], message: `use um pico maior que o mínimo de pessoas (${v.minimo}); senão sairia de uma call cheia` })
    }
  })

/**
 * Emenda 21: a configuração do motor por API, por perfil. A CHAVE não está aqui de propósito (ela
 * tem armazenamento próprio), e `strict()` garante que um campo a mais, inclusive um que parecesse
 * uma chave, não passa pelo ui:save-settings.
 */
export const apiTranscriptionSchema = z
  .object({
    ativa: z.boolean(),
    provedor: z.string().min(1).max(50),
    endpoint: z
      .string()
      .max(500)
      .refine((v) => !v.trim() || isAllowedEndpoint(v.trim()), { message: 'endereço não permitido: use a API do provedor declarado' }),
    modelo: z.string().max(100),
    idioma: z.string().regex(/^(auto|[a-z]{2,3})$/, { message: 'use auto ou um código de idioma como pt ou en' }),
  })
  .strict()

export const settingsSchema = z.object({
  profileId: z.string().max(100),
  profileLabel: z.string().max(60),
  autoMeet: z.boolean(),
  autoTeams: z.boolean(),
  minSeconds: z.number().int().min(0).max(3600),
  autoLeave: z.boolean(),
  vigiaIndicador: z.boolean(),
  vigia: vigiaCfgSchema,
  language: z.enum(UI_LANGUAGES),
  apiTranscription: apiTranscriptionSchema,
})

/** Caminho absoluto ou começando com ~; vazio vale (o helper descobre sozinho). */
const optionalPath = z
  .string()
  .max(4096)
  .refine((v) => !v.trim() || v.trim().startsWith('/') || v.trim().startsWith('~'), { message: 'use um caminho absoluto ou começando com ~' })

/**
 * Configuração da transcrição como as configurações editam (Emenda 13). O helper valida de novo,
 * e é ele quem confere se o modelo e os programas existem.
 */
export const transcriptionConfigSchema = z.object({
  ativa: z.boolean(),
  motor: z.string().min(1).max(50),
  modelo: optionalPath,
  idioma: z.string().regex(/^(auto|[a-z]{2,3})$/, { message: 'use auto ou um código de idioma como pt ou en' }),
  whisperCli: optionalPath,
  ffmpeg: optionalPath,
})

/** Mudança pedida pelas configurações (ui:set-transcription): só campos conhecidos. */
export const transcriptionPatchSchema = transcriptionConfigSchema.partial().strict()

const vigiaStatusShape = {
  platform: platformSchema,
  naCall: z.boolean(),
  n: z.number().int().nonnegative().nullable(),
  fonte: z.string().max(100).nullable(),
  pico: nonNegInt,
  limite: z.number().nonnegative(),
  armado: z.boolean(),
  seguidas: nonNegInt,
  saindo: z.boolean(),
  tentativas: nonNegInt,
}

export const vigiaUpSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('vigia:status'), ...vigiaStatusShape }),
  z.object({ t: z.literal('vigia:saindo'), motivo: z.string().max(300), pico: nonNegInt, n: nonNegInt.nullable() }),
  z.object({ t: z.literal('vigia:fechar-aba'), motivo: z.enum(['saiu-da-call', 'a-call-acabou']) }),
  z.object({ t: z.literal('vigia:nao-consegui-sair'), motivo: z.string().max(300) }),
  z.object({ t: z.literal('vigia:nesta-call'), desligado: z.boolean() }),
])

/** Valida uma mensagem do vigia; devolve null se for inválida. */
export function parseVigiaUp(raw: unknown): VigiaUp | null {
  const r = vigiaUpSchema.safeParse(raw)
  return r.success ? (r.data as VigiaUp) : null
}

/** Valida uma mensagem Up; devolve null se for inválida. */
export function parseUp(raw: unknown): Up | null {
  const r = upSchema.safeParse(raw)
  return r.success ? (r.data as Up) : null
}

// ---------------------------------------------------------------------------------------------
// Volume por aba (Emenda 14): pedidos do popup validados no SW
// ---------------------------------------------------------------------------------------------

const tabIdSchema = z.number().int().nonnegative()

export const tabVolumeReqSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ui:tab-volume-get'), tabId: tabIdSchema }),
  // Qualquer número finito: o SW limita a 0..2 (clampVolume).
  z.object({ t: z.literal('ui:tab-volume-set'), tabId: tabIdSchema, volume: z.number().finite() }),
])

/** Valida um pedido de volume do popup; devolve null se for inválido. */
export function parseTabVolumeReq(raw: unknown): Extract<UiReq, { t: 'ui:tab-volume-get' | 'ui:tab-volume-set' }> | null {
  const r = tabVolumeReqSchema.safeParse(raw)
  return r.success ? r.data : null
}
