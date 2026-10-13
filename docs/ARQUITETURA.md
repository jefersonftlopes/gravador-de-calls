# Arquitetura

Contrato técnico para quem constrói. O `ESPEC.md` diz **o que** precisa acontecer; este arquivo diz **como**. A pesquisa que embasa cada decisão está em `docs/pesquisa/` (`chrome-e-audio.txt`, `meet-e-teams.txt`, `pesquisa-2026-10-06.json` com fontes e datas, e `lab/` com scripts que reproduzem as medições de áudio no Chromium).

## Visão geral

```
aba da call (meet.google.com / teams.*)
├─ MAIN world  src/main-world/hook.iife.ts   (document_start, all_frames, match_origin_as_fallback)
│   ├─ capture/registry.ts   ganchos: RTCPeerConnection, getUserMedia, srcObject, createMediaStreamSource, AudioNode.connect
│   ├─ capture/mixer.ts      AudioContext próprio (sinkId none): grupos por fonte, analisadores, atraso 1,5 s, seletor
│   ├─ capture/recorder.ts   MediaRecorder webm/opus 32 kbps mono, timeslice 5 s, seq
│   ├─ platforms/meet.ts, platforms/teams.ts   em call? fim? metadados
│   ├─ session.ts            máquina de estados da sessão desta frame
│   └─ bridge.ts             window.postMessage <-> relay
│         ▲  window.postMessage { __gravador__: ... }
│         ▼
├─ ISOLATED  src/content/relay.ts  (document_start, all_frames)
│         ▲  chrome.runtime Port "gravador:sessao" (JSON; áudio em base64)
│         ▼
service worker  src/background/
├─ sessions.ts    registro por tabId, IndexedDB, finalizar, recuperar
├─ sink-host.ts   native messaging com o helper (grava na pasta escolhida)
├─ sink-downloads.ts  reserva: monta o Blob no offscreen e usa chrome.downloads
├─ tabcapture.ts  modo aba (atalho/popup) -> offscreen
├─ badge.ts, notifications
└─ ui-api.ts      mensagens do popup/options
offscreen  src/offscreen/   (BLOBS + USER_MEDIA + AUDIO_PLAYBACK): Blob para downloads, gravadores do modo aba
popup, options  src/popup/, src/options/   (React + Tailwind)
helper  host/gravador-host.mjs  (Node, sem dependências), host/instalar.mjs, host/desinstalar.mjs
```

## Regras do MAIN world (não negociáveis)

O script do MAIN world roda dentro do Meet e do Teams. Se ele quebrar, quebra a call do usuário.

1. **Sempre chamar o original primeiro e devolver exatamente o que ele devolveu.** Toda lógica nossa fica depois, dentro de `try/catch` que engole e registra o erro. Nenhuma exceção nossa pode subir para a página.
2. **Instalar uma vez por realm**, com uma marca (`Symbol.for('gravador.hook')`) no `window`. Guardar referências aos originais na instalação e usar só os originais na nossa própria lógica (nunca chamar um método que nós mesmos embrulhamos, para não registrar a nossa própria fonte).
3. **Nada de Trusted Types:** proibido `innerHTML`, `outerHTML=`, `insertAdjacentHTML`, `eval`, `new Function`, `script.src` com string, `setTimeout(string)`, worklet ou worker por `blob:`. Meet e Teams aplicam `require-trusted-types-for 'script'`.
4. **Nunca conectar nada nosso a um `AudioDestinationNode`** (som duplicado) e nunca criar `<audio>` audível. O AudioContext do mixer usa `sinkId: { type: 'none' }`.
5. **Nunca chamar `createEncodedStreams()` nem `transform`** em receptores da página, e nunca passar `encodedInsertableStreams`. Só pode ser chamado uma vez e roubaria o pipeline do Meet/Teams.
6. **Nunca adicionar saída a um `AudioWorkletNode` da página** (o NetEQ do Meet derruba o renderer). O tee de saída só atua em nós nativos.
7. **Construtor via `Proxy`** (`new Proxy(Original, { construct })`), preservando `instanceof`, protótipo e estáticos (`generateCertificate`). Trocar também `webkitRTCPeerConnection`.
8. Sem dependência de `chrome.*` (não existe no MAIN world). Sem `import()` dinâmico.

## Captura: as quatro fontes ("seams")

Cada fonte é um grupo de nós no **AudioContext do mixer** (nosso, `sinkId: none`, criado só quando a sessão começa).

| id | nome no info.json | de onde vem | detalhe |
|---|---|---|---|
| `receivers` | receptores | evento `track` (via `addEventListener` e setter `ontrack` embrulhados no PC) e, por garantia, `getReceivers()` dos PCs registrados | só faixas `kind === 'audio'`, `readyState === 'live'`, transceptor com `currentDirection` contendo `recv` (ou ainda não negociado mas com pacotes). O adaptador pode filtrar (Teams: se existir stream com id começando por `mainAudio`, usar só esse e ignorar `dominantSpeaker-*`) |
| `elements` | elementos | setter `HTMLMediaElement.prototype.srcObject` embrulhado + varredura periódica de `audio, video` | só faixas de áudio que não sejam locais |
| `sources` | fontes | `BaseAudioContext.prototype.createMediaStreamSource` (e `createMediaStreamTrackSource` se existir) embrulhado | registra o stream que a página passou; pega as faixas não locais |
| `output` | saída | `AudioNode.prototype.connect` embrulhado: quando o destino é um `AudioDestinationNode` e a origem **não** é `AudioWorkletNode` nem um `MediaStreamAudioSourceNode` de faixa local, conecta também num `MediaStreamAudioDestinationNode` por contexto da página (o "tee"). `disconnect` também embrulhado para manter o tee coerente | o stream do tee é local, então entra no mixer sem o problema do crbug 40094084 |

**Faixas locais (nunca gravar):** toda faixa vinda de `getUserMedia`/`getDisplayMedia` (embrulhados), seus `clone()` (embrulhar `MediaStreamTrack.prototype.clone`), e toda faixa usada como envio (`addTrack`, `addTransceiver`, `RTCRtpSender.prototype.replaceTrack`, `getSenders()`). Isso exclui o microfone mesmo depois de processado por cancelamento de ruído.

**Priming (crbug 40094084):** faixa remota só produz áudio no WebAudio se algum elemento da mesma frame estiver tocando áudio WebRTC. Se não houver nenhum elemento da página com áudio remoto, criar `const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([track])` e guardar a referência (sem `play()`, fora do DOM). Medido no Chrome 154: basta.

**Mixer:**

```
fonte (cada faixa)  -> MediaStreamAudioSourceNode -> grupo[seam] (GainNode soma)
grupo[seam] -> AnalyserNode (sem atraso, para medir energia)
grupo[seam] -> DelayNode(1.5 s) -> seletor[seam] (GainNode 0 ou 1) -> destino (MediaStreamAudioDestinationNode, channelCount 1, explicit)
```

**Arbitragem** (laço de 250 ms; função pura `arbitrate(state, measurements, now)` em `capture/arbitration.ts`, testada com vitest):

- energia em dBFS por grupo; "tem fala" quando acima de -55 dBFS.
- seam inicial: o primeiro da prioridade do adaptador que tiver alguma fonte. Prioridade Meet: `receivers, sources, elements, output`. Teams: `elements, receivers, sources, output`.
- troca só quando o seam selecionado está sem fala há pelo menos 1 s **e** outro seam teve fala no último 1 s; escolhe o de maior prioridade entre os que têm fala. Nunca troca "para cima" se o atual está funcionando (evita oscilar).
- a troca é feita com rampa curta (`setTargetAtTime`, ~20 ms) nos seletores. Como os seletores ficam depois do atraso de 1,5 s, a troca vale para o áudio de até 1,5 s atrás.
- toda troca vira `{ at, from, to }` em `seamSwitches` no info.json.

**Gravador:** `MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })`, `start(5000)`. Cada `dataavailable` vira chunk com `seq` crescente a partir de 0. O chunk 0 contém o cabeçalho EBML: sem ele nada decodifica, então ele precisa de confirmação antes de qualquer coisa.

**AudioContext suspenso** (aba recarregada pelo navegador sem novo clique): se `state === 'suspended'`, chamar `resume()`, e registrar `pointerdown`/`keydown` em captura no `window` para tentar de novo. Reportar `ctxState` no diagnóstico.

## Adaptadores de plataforma

```ts
interface PlatformAdapter {
  id: 'meet' | 'teams'
  matchesUrl(loc: Location): boolean               // gate: só aí a sessão pode existir
  seamPriority: SeamId[]
  acceptReceiverTrack?(track: MediaStreamTrack, streams: readonly MediaStream[]): boolean
  isInCall(probe: Probe): boolean                  // avaliado a cada 1 s
  endSignal(probe: Probe): EndReason | null        // fim imediato (tela de saída, estado 6/7)
  isOnHold?(probe: Probe): boolean                 // Teams estado 4/5
  readMeta(): Partial<CallMeta>                    // título, código, participantes, selfName
}
```

`Probe` dá ao adaptador o estado dos PCs registrados (quantos abertos, algum `connected` com receptor de áudio vivo) sem expor os objetos.

**Meet** (`docs/pesquisa/meet-e-teams.txt` tem os seletores com data):
- URL: `meet.google.com` e caminho `^/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:/|$)`.
- Em call = URL ok **e** botão de sair (`button[jsname="CQylAd"]` ou ícone `.google-symbols` com texto `call_end`) **e** ícone de legenda ou chat (`.google-symbols` com texto `closed_caption`/`closed_caption_off`/`chat`) **e** sem cabeçalho de saída `h1[jsname="r4nke"]` **e** algum PC `connected` com receptor de áudio vivo. Estável por 2 s. (O Meet cria um PC descartável em toda página com código: criação de PC não é sinal.)
- Fim: cabeçalho de saída aparece; ou `pc.close()` embrulhado no PC que tinha áudio sem outro PC com áudio em 5 s; ou "em call" falso por 15 s seguidos.
- Título: `[jsname="NeC6gb"]` ou `.u6vdEc` (reler por ~10 s após entrar e de novo no fim; descartar se for igual ao código); depois `document.title` sem o prefixo/sufixo "Meet"/"Google Meet"; por fim o código. `[data-meeting-title]` sumiu em jun/2026: não usar.
- Participantes: a cada 5 s, nomes de `[data-participant-id]` via `span.notranslate`; excluir o bloco que contém `[data-self-name]` e rótulos de efeitos/`Google Participant (`/`spaces/`/`devices/`. Acumular num Set. `selfName` de `[data-self-name]`.

**Teams:**
- URL: hosts `teams.microsoft.com`, `teams.cloud.microsoft`, `teams.live.com`.
- Objeto da call (MAIN world): `window.callingDebug?.observableCall ?? window.msteamscalling?.deref?.()?.callingService?.getActiveCall?.()`. Ler tudo com optional chaining dentro de `try`.
- Em call = estado `3` (Connected). Sem objeto: `#hangup-button` (ou `[data-tid="hangup-main-btn"]`, `[data-inp="hangup-button"]`, `[data-tid="call-hangup"]`) presente **e** nenhum marcador de pré-join/lobby (`[data-tid="prejoin-join-button"]`, `[data-tid="prejoin-display-name-input"]`, `button[data-tid="joinOnWeb"]`).
- Espera: estado `4` ou `5`: continua gravando (silêncio), marca período em `holds`.
- Fim: estado `6` ou `7`; ou tela `[data-testid="calling-anon-meeting-end-screen"]`; ou botão de desligar ausente por 5 s com a faixa principal encerrada; ou "em call" falso por 15 s.
- Título: `document.title` sem o sufixo ` | Microsoft Teams` (descartar "Microsoft Teams meeting"); `[data-tid="meeting-header-title"]` (atributo `title`), lido já no pré-join e guardado.
- Participantes: `call.participants[]` (`displayName`, ignorar `state === 7` e nomes vazios); `selfName` de `call.localSignalingParticipant.displayName`. Reserva: `[data-cid="roster-participant"]` com `data-tid` começando por `participantsInCall-`/`attendeesInMeeting-`.
- ID: `call.threadId`, ou regex `19:meeting_[A-Za-z0-9_-]+@thread\.v2` na URL; código curto de `/meet/(\d{10,15})`.

## Sessão na frame (`session.ts`)

`idle -> candidata (em call, esperando 2 s estável) -> gravando -> finalizando -> encerrada`. Depois de encerrada, uma nova call na mesma aba abre outra sessão.

- Ao virar `gravando`: cria mixer e gravador, manda `session:start` e espera `session:accepted` (o SW pode recusar: plataforma desligada, ou outra frame da mesma aba já está gravando).
- Metadados: `session:meta` quando mudar (no máximo a cada 5 s).
- Diagnóstico: `session:diag` a cada 5 s.
- Fim: para o gravador, espera o último `dataavailable`, manda `session:end` com `lastSeq`.
- `pagehide`: tenta `requestData()`/`stop()` e manda `session:end` com motivo `pagehide`; se não der tempo, o SW finaliza pelo `onDisconnect` + `tabs.onRemoved`.

## Protocolo (tipos em `src/shared/protocol.ts`, validados com zod no SW)

MAIN <-> ISOLATED: `window.postMessage({ __gravador__: 1, dir: 'up' | 'down', msg })` restrito a `window.location.origin`. O relay aceita só `dir: 'up'` e só repassa tipos conhecidos. Cada frame tem seu Port.

Do conteúdo para o SW (Port `gravador:sessao`):

```ts
type Up =
  | { t: 'hello'; frameUrl: string; isTop: boolean; platform: Platform | null; hookVersion: string; hookedAt: number }
  | { t: 'session:start'; localId: string; platform: Platform; startedAt: number; meta: Partial<CallMeta> }
  | { t: 'session:resume'; localId: string; sessionId: string; nextSeq: number }        // depois de reconectar o Port
  | { t: 'session:chunk'; sessionId: string; seq: number; data: string /* base64 */; bytes: number; at: number }
  | { t: 'session:meta'; sessionId: string; meta: Partial<CallMeta> }
  | { t: 'session:diag'; sessionId: string; diag: CaptureDiag }
  | { t: 'session:end'; sessionId: string; endedAt: number; reason: EndReason; lastSeq: number }
```

Do SW para o conteúdo:

```ts
type Down =
  | { t: 'session:accepted'; localId: string; sessionId: string }
  | { t: 'session:rejected'; localId: string; reason: 'disabled' | 'other-frame' | 'other' }
  | { t: 'chunk:ack'; sessionId: string; seq: number }
  | { t: 'session:stop'; sessionId: string; reason: 'user' }
  | { t: 'settings'; autoMeet: boolean; autoTeams: boolean }
```

O relay guarda os chunks sem `ack` em memória e reenvia depois de reconectar o Port (o SW pode reiniciar). O SW grava cada chunk no IndexedDB **antes** de mandar o `ack`.

## Service worker

- **Sessões** por `tabId` (uma ativa por aba e por tipo: `pagina` e `aba`). `sessionId = AAAAMMDD-HHmmss-<tabId>-<4 hex>`.
- **IndexedDB** `gravador` (versão 1): store `sessions` (chave `sessionId`; tabId, frameId, platform, kind `pagina|aba`, status `gravando|finalizando|salva|descartada|interrompida`, startedAt, endedAt, meta, diag, seamSwitches, holds, nextSeq, gaps, sink, hostFlushedSeq) e store `chunks` (chave `[sessionId, seq]`, valor `{ data: Blob, at }`). Chunks ficam até a sessão ser salva com sucesso.
- **Destino (sink):** se o helper responder ao `ping`, usa o helper: `begin` no início, `append` a cada chunk (em ordem; o helper recusa fora de ordem), `finalize` no fim. Se o helper sumir no meio, continua guardando no IndexedDB e, no fim, reenvia o que falta; se não houver helper no fim, usa downloads.
- **Finalizar:** monta `info.json`, calcula o nome da pasta, chama o sink, marca `salva`, apaga os chunks, adiciona em `recentes` (chrome.storage.local, máximo 20). Duração abaixo do mínimo: `discard` e marca `descartada`.
- **Recuperar** (ao iniciar o SW): sessões `gravando` cuja aba não existe mais, ou que não reconectaram em 30 s, viram `interrompida` e são finalizadas com o que houver.
- `chrome.tabs.update(tabId, { autoDiscardable: false })` enquanto grava; restaura no fim.
- **Badge** por aba: `REC` vermelho gravando com áudio; `REC` âmbar se 60 s sem energia desde o início (e notificação uma vez); `↻` em abas de call abertas antes da instalação/atualização.
- **Instalação/atualização:** varre abas que casam com os hosts e marca `↻` + notificação "recarregue a aba da call para gravar".

## Modo aba (`tabcapture.ts` + offscreen)

- Comando `gravar-aba` (sugestão `Alt+Shift+G`) e botão no popup. Os dois contam como invocação da extensão na aba.
- `chrome.tabCapture.getMediaStreamId({ targetTabId })` no SW, entregue ao offscreen em até 10 s. No offscreen: `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })`, `AudioContext` com a fonte ligada no `destination` (para ele continuar ouvindo) e num `MediaStreamAudioDestinationNode` mono gravado como acima.
- Chunks do offscreen para o SW por um Port próprio (`gravador:aba`), mesma lógica de seq/ack/IndexedDB. Sessão `kind: 'aba'`, arquivo `audio-aba.webm`, na mesma pasta da sessão de página da aba se houver, senão pasta própria.
- Para quando: atalho de novo, botão parar, aba fechada, ou a sessão de página da aba terminar.

## Helper (native messaging)

- Nome `com.enkode.gravador_calls`. Manifesto do host em `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (e, para testes, em `<user-data-dir>/NativeMessagingHosts/`). `allowed_origins` com o ID fixo da extensão (chave pública em `manifest.key`; a chave privada fica em `.keys/`, fora do git).
- `instalar.mjs` gera um wrapper `host/gravador-host.sh` com o caminho absoluto do `node` (`process.execPath`), porque o Chrome abre o host sem o PATH do terminal.
- Protocolo stdio: 4 bytes de tamanho (little-endian no Mac) + JSON. Mensagens do host para o Chrome até 1 MB.

```ts
type HostReq =
  | { id: number; op: 'ping' }
  | { id: number; op: 'check-root'; root: string }                 // existe? dá para gravar? cria se não existir
  | { id: number; op: 'choose-folder'; prompt: string }            // osascript "choose folder"
  | { id: number; op: 'begin'; root: string; sessionId: string }   // cria <root>/.gravando/<sessionId>/
  | { id: number; op: 'append'; root: string; sessionId: string; file: string; seq: number; data: string }
  | { id: number; op: 'finalize'; root: string; sessionId: string; relDir: string; info: object }
  | { id: number; op: 'discard'; root: string; sessionId: string }
  | { id: number; op: 'list-staging'; root: string }
  | { id: number; op: 'reveal'; path: string }                     // open -R
type HostRes = { id: number; ok: true; [k: string]: unknown } | { id: number; ok: false; error: string; expected?: number }
```

- `append` grava em `<staging>/<file>.part` e faz `fsync` antes de responder. Recusa `seq` diferente do esperado e devolve `expected`.
- `finalize` renomeia `.part` para o nome final, move a pasta de staging para `<root>/<relDir>` (sufixo ` (2)`, ` (3)` se existir) e escreve `info.json` por último. Devolve o caminho final.
- `~` no caminho é expandido pelo helper.

## Nomes (`src/shared/naming.ts`, testado com vitest)

`<AAAA-MM>/<AAAA-MM-DD HHhMM> - <título> (<Meet|Teams>)`, com hora local. Saneamento compatível com as regras do Chromium (valem também para o modo downloads): trocar `" * / : < > ? \ |` e caracteres de controle/formatação; tirar espaço, `.` e `~` das pontas de cada parte; evitar nomes reservados do Windows; limitar cada parte a ~120 bytes UTF-8; título vazio vira o código da reunião ou "Sem título".

## info.json

```json
{
  "versao": 1,
  "plataforma": "meet",
  "titulo": "Daily do time",
  "tituloFonte": "dom",
  "codigo": "abc-defg-hij",
  "url": "https://meet.google.com/abc-defg-hij",
  "tituloDaAba": "Meet - Daily do time",
  "inicio": "2026-10-06T14:30:05-03:00",
  "fim": "2026-10-06T15:02:41-03:00",
  "duracaoSegundos": 1956,
  "fuso": "America/Sao_Paulo",
  "participantes": ["Fulano", "Ciclana"],
  "voce": "Alex Lima",
  "arquivos": [{ "nome": "audio.webm", "tipo": "pagina", "bytes": 7812345, "formato": "audio/webm;codecs=opus", "kbps": 32 }],
  "captura": { "fonteInicial": "receivers", "fonteFinal": "receivers", "trocas": [], "contextoAudio": "running" },
  "esperas": [],
  "lacunas": [],
  "status": "concluida",
  "motivoFim": "saiu-da-call",
  "extensao": "0.1.0",
  "helper": "0.1.0",
  "idiomaInterface": "pt-BR"
}
```

`idiomaInterface` (Emenda 19, 0.4.1): `pt-BR` ou `en`, o idioma escolhido nas configurações quando a gravação foi salva; o helper escreve nele o cabeçalho do `transcricao.md`. Só existe com Português (Brasil) ou English escolhidos: no Automático (o padrão) o campo fica de fora, qualquer que seja o idioma do Chrome, e o `info.json` sai igual ao de antes da 0.4.1. Um `info.json` sem o campo (Automático, de antes da 0.4.1, ou o de um staging órfão) é lido como `pt-BR`.

## Testes

- **Unidade (vitest):** `naming.ts`, `arbitration.ts`, protocolo do helper (framing, ordem de `append`, `finalize` com colisão), validação zod.
- **Ponta a ponta (Playwright, Chromium do Playwright):** extensão carregada com `--load-extension`, perfil temporário, helper instalado no `<user-data-dir>/NativeMessagingHosts` apontando para uma raiz temporária. Microfone falso com `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav de 1000 Hz>`.
- **Páginas de teste** servidas com `context.route('https://meet.google.com/**')` e `https://teams.microsoft.com/**` (assim o manifesto real é exercitado). O "participante remoto" é outra aba no mesmo host (ex.: `https://meet.google.com/__peer?tom=440&sala=x`), com sinalização por `BroadcastChannel`; ela toca um tom pelo PC. A página da call manda o microfone falso como envio. Variantes da página da call:
  1. `normal`: faixa remota num `<audio>` (padrão do Meet).
  2. `sem-audio`: sem nenhum elemento (A/B do Meet): exige o priming.
  3. `decoy`: o PC carrega silêncio; o tom chega por DataChannel em PCM e a página toca via `MediaStreamTrackGenerator` -> `createMediaStreamSource` -> `destination`.
  4. `teams-elemento`: faixa `mainAudio` muda; tom via gerador -> `MediaStreamDestination` -> `<audio>` no body.
  5. `saida`: tom só por `AudioBufferSourceNode` -> `GainNode` -> `destination`.
  Cada página imita os marcadores de DOM da plataforma (botão de sair, ícone de legenda, título, blocos de participantes, cabeçalho de saída ao sair; no Teams, um `window.msteamscalling` falso com estado e participantes).
- **Análise:** `ffmpeg` decodifica para PCM mono 16 kHz; Goertzel por janela de 1 s nas frequências esperadas; duração decodificada perto do relógio.
- **Integridade da página:** a página de teste mede a energia do próprio áudio dela com e sem a extensão e registra erros de console; os dois têm de bater.
- **Modo aba:** Playwright com `--allowlisted-extension-id=<id>` (libera o `getMediaStreamId` sem gesto) e um gatilho de teste no SW.
- **Real:** call de verdade no Meet e no Teams, feita pelo usuário. Bloqueia o "pronto".

## Emenda 1: vários perfis do Chrome (06/10/2026)

O usuário tem um perfil do Chrome por empresa, e cada call roda no perfil da empresa. Esta emenda **substitui** o que estiver em conflito acima.

- **Instalação por perfil, helper único.** A extensão é carregada em cada perfil. O ID é o mesmo em todos (chave fixa no manifesto), então um só manifesto de host em `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` atende todos. Cada perfil abre o seu próprio processo do helper: o helper precisa aguentar vários processos ao mesmo tempo na mesma raiz.
- **A raiz mora no helper.** Arquivo de configuração `~/Library/Application Support/gravador-de-calls/config.json` (`{ "root": "~/Documents/Gravações de calls" }`). O wrapper gerado pelo `instalar.mjs` pode embutir `GRAVADOR_CONFIG=<caminho>` para os testes usarem outra configuração. As operações deixam de receber `root`:

```ts
type HostReq =
  | { id: number; op: 'ping' }                                         // devolve versão e a raiz atual (+ se dá para gravar)
  | { id: number; op: 'get-config' }
  | { id: number; op: 'set-root'; path: string }                       // valida, cria se não existir, grava no config.json
  | { id: number; op: 'check-root'; path: string }                     // só valida um caminho candidato
  | { id: number; op: 'choose-folder'; prompt: string }
  | { id: number; op: 'begin'; sessionId: string; owner: string }      // <root>/.gravando/<sessionId>/ + owner.json
  | { id: number; op: 'append'; sessionId: string; file: string; seq: number; data: string }
  | { id: number; op: 'finalize'; sessionId: string; relDir: string; info: object }
  | { id: number; op: 'discard'; sessionId: string }
  | { id: number; op: 'list-staging'; owner: string }                  // só as sessões deste perfil
  | { id: number; op: 'reveal'; path: string }
```

- **Dono de cada sessão.** Na instalação, cada perfil gera um `profileId` (UUID) em `chrome.storage.local`. `begin` grava o dono no staging, e `list-staging` e a recuperação só enxergam as sessões do próprio perfil. A recuperação de um perfil nunca finaliza a gravação viva de outro.
- **Nome do perfil.** Configuração por perfil `profileLabel` (texto livre, ex.: "Trabalho"), opcional. Vai no `info.json` como `"perfil"` e vira a primeira pasta: `relDir = [<perfil>/]<AAAA-MM>/<AAAA-MM-DD HHhMM> - <título> (<Meet|Teams>)`, saneado como os outros nomes. Vazio: sem esse nível, e o popup sugere preencher.
- **Configurações por perfil** (`chrome.storage.local`): `profileId`, `profileLabel`, `autoMeet`, `autoTeams`, `minSeconds`. A raiz aparece nas configurações de todos os perfis, mas é lida e gravada pelo helper (`get-config`/`set-root`).
- **Reserva da pasta final sem corrida.** `finalize` reserva o destino com `mkdir` não recursivo do último nível (falha com `EEXIST` e tenta ` (2)`, ` (3)`...), move os arquivos para dentro e escreve `info.json` por último. Nunca usar "existe? então cria" em dois passos, porque dois helpers podem finalizar ao mesmo tempo.
- **Reserva de downloads** (sem helper): `Gravações de calls/[<perfil>/]<AAAA-MM>/...` dentro da pasta de downloads daquele perfil.
- **Teste:** dois contextos persistentes (dois perfis) gravando ao mesmo tempo na mesma raiz, com títulos iguais no mesmo minuto: duas pastas (`X` e `X (2)`), cada uma com o seu tom. E a recuperação do perfil A rodando enquanto o perfil B grava não toca no staging de B.

## Emenda 2: sair e fechar a call sozinho no Teams ("vigia") (06/10/2026)

Porte do script do usuário (`docs/referencia/vigia-original.js`) para dentro da extensão, com uma chave para ligar e desligar. O comportamento deve ser o mesmo do script; a única mudança proposital é **quem fecha a aba e quando**.

- **Onde roda:** content script ISOLATED, só na frame do topo (`window.top === window`), só nos hosts do Teams. Arquivos `src/content/vigia/regua.ts` (função pura, porte fiel de `criarRegua` e do cálculo de `limite`, `armado`, `sair`), `src/content/vigia/contagem.ts` (porte de `contar`, `emCall`, `painelAberto`, `botaoSair`, com os mesmos seletores e a mesma regex) e `src/content/vigia/vigia.ts` (o laço `tick`, o indicador na página e a conversa com o SW). Não precisa do MAIN world: é só DOM e `element.click()`. Indicador na página com `createElement` + `style.cssText` + `textContent` (sem `innerHTML`).
- **Seletores verificados ao vivo pelo usuário** (valem também como sinais extras de "em call" no adaptador do Teams): `#hangup-button`, `#microphone-button`, `#call-duration-custom`, `#roster-button`, `[id^="roster-title-section"]` (contagem em `aria-label`/texto, "In this meeting (N)" / "Nesta reunião (N)"), `#roster-participants-search-input`.
- **Configuração** (por perfil, `chrome.storage.local`): `autoLeave: false`, `vigiaIndicador: true`, `vigia: { intervaloSeg: 5, fracao: 0.3, minimo: 2, picoParaQueda: 4, confirmacoes: 4, faltasParaFim: 3 }`. Mudou a configuração com a call aberta: o vigia aplica na próxima leitura.
- **Mensagens** (o vigia está no ISOLATED world e fala direto com o SW por um Port `gravador:vigia`):

```ts
type VigiaUp =
  | { t: 'vigia:status'; naCall: boolean; n: number | null; fonte: string | null; pico: number; limite: number; armado: boolean; seguidas: number; saindo: boolean; tentativas: number }
  | { t: 'vigia:saindo'; motivo: string; pico: number; n: number | null }     // mandado ANTES do primeiro clique em sair
  | { t: 'vigia:fechar-aba'; motivo: 'saiu-da-call' | 'a-call-acabou' }      // no lugar do window.close() do script
type VigiaDown =
  | { t: 'vigia:config'; autoLeave: boolean; indicador: boolean; cfg: VigiaCfg }
  | { t: 'vigia:sair-agora' }
  | { t: 'vigia:desligar-nesta-call' }
```

- **Fechar a aba depois de salvar.** Ao receber `vigia:fechar-aba`, o SW espera a sessão de página daquela aba (se houver) receber `session:end` e ter todos os chunks até `lastSeq` gravados no IndexedDB, e então chama `chrome.tabs.remove(tabId)`. Limite de espera: 20 s; passou disso, fecha assim mesmo (o que já está no IndexedDB é finalizado pelo `tabs.onRemoved`). Sem sessão de gravação, fecha na hora. Nada de `window.close()` nem `about:blank`.
- **info.json:** quando a saída foi automática, `"saidaAutomatica": { "motivo": "caiu de 8 para 2", "pico": 8, "na": 2, "em": "<ISO>" }` e `motivoFim: "saida-automatica"`.
- **Popup:** na call do Teams com o vigia ligado, mostra `n na call | pico | sai com <= limite` e os botões "Sair agora" (equivale a `sairAgora`) e "Desligar nesta call" (equivale a `parar`, só para aquela aba até ela navegar).
- **Testes:**
  - Unidade da régua, com tabela dos casos do script: pico 2 e 3 só saem sozinho; pico 8 sai com <= 2 depois de 4 leituras; leitura `null` não zera nem conta; sozinho sai na hora.
  - Ponta a ponta numa página que imita o Teams: painel People com `[id^="roster-title-section"]` e `aria-label` "Nesta reunião (N)", `#roster-button` que abre o painel, N mudando por comando do teste, `intervaloSeg` reduzido. Casos: ficar sozinho sai e fecha; queda proporcional espera as confirmações; desligado não faz nada; a call sumir fecha depois de 3 leituras; a aba só fecha depois do `info.json` existir; o áudio gravado vai até o momento da saída.

## Emenda 3: o vigia também no Meet (06/10/2026)

A Emenda 2 vale para o Meet também, com a mesma régua e a mesma configuração (os seis números são os mesmos para as duas plataformas). O que muda é só a camada de DOM:

- `src/content/vigia/contagem.ts` passa a ter uma implementação por plataforma com a mesma interface (`emCall`, `botaoSair`, `painelAberto`, `abrirPainel`, `contar`). Teams: exatamente o script. Meet: sinais de "em call" iguais aos do adaptador (botão de sair **e** ícone de legenda ou chat **e** sem `h1[jsname="r4nke"]`); botão de sair `button[jsname="CQylAd"]` ou o botão cujo ícone `.google-symbols` tem o texto `call_end`; contagem pelo atributo `[data-avatar-count]` (selo ao lado dos avatares no canto superior direito, interface nova desde dez/2025; `Number(getAttribute('data-avatar-count'))`, aceito só inteiro > 0; **inclui você**, então "sozinho" é 1 como no Teams). Reserva, só se o painel de pessoas **já estiver aberto**: nomes únicos de `[role="listitem"][data-participant-id]` dentro de `[role="list"]`, sem as linhas de apresentação ("Apresentação", "Presentation", "apresentação de <nome>") e sem as de "áudio mesclado". Último recurso: `button[aria-label^="People - "]` com `/(\d+)/`, `div.egzc7c`, `.uGOf1d` (interface antiga). Fontes e datas em `docs/pesquisa/vigia-meet-2026-10-06.json`.
- **No Meet o vigia não abre o painel de pessoas sozinho** (diferente do script do Teams): no Meet o painel de pessoas e o chat dividem o mesmo espaço, então abrir pessoas fecharia o chat do usuário, e o botão novo abre um balão. Sem contagem, a leitura é `null` e não dispara nada, como no script.
- **Contagem de blocos de vídeo (`[data-participant-id]`) nunca dispara saída**: o Meet não renderiza todo mundo. Ela só aparece no diagnóstico.
- **Diálogo do organizador no Meet:** depois do clique em sair, se aparecer um diálogo, esperar até ~2 s por `[role="dialog"]`, `[role="alertdialog"]` ou `[data-mdc-dialog-action]` e clicar só no botão cujo texto ou `aria-label` (aparado) bate com `/^(just leave( the call)?|leave meeting|leave call|apenas sair( da chamada)?|sair da reuni[aã]o|sair da chamada)$/i` **e** não bate com `/everyone|for all|todos|encerrar|^end /i` (`[data-mdc-dialog-action="Pd96ce"]` é só uma dica, e o texto dele também passa pelos dois testes). Um clique em `CQylAd` sozinho nunca encerra para todos: o risco está só no segundo clique. Sem diálogo, a saída já aconteceu. Se nenhum botão passar nos dois testes, não clicar em nada, parar de tentar e avisar por notificação ("Não consegui sair da call sozinho: confirme na aba"). O teste ponta a ponta cobre os dois diálogos.
- O indicador na página mostra a fonte da contagem (`botão de pessoas`, `painel de pessoas`), para o usuário conferir nas primeiras calls reais se o número bate.

## Emenda 4: fronteiras das fatias paralelas (06/10/2026)

Fecha as lacunas de contrato achadas na verificação da fatia 1, para as próximas fatias andarem em paralelo sem editar arquivos umas das outras. Esta emenda **substitui** o que estiver em conflito acima.

**Quem é dono de quê.** Cada fatia mexe só nos seus arquivos e usa os pontos de extensão listados. Mudar um arquivo compartilhado (inclusive `src/shared/protocol.ts` e `src/shared/constants.ts`) é mudança de contrato: vira uma emenda nova, não um detalhe da fatia.

| fatia | arquivos dela | usa |
|---|---|---|
| adaptadores (Meet endurecido, Teams) | `src/main-world/platforms/meet.ts`, `teams.ts` e testes de unidade deles; `tests/fixtures/teams/**`; variantes novas em `tests/fixtures/meet/variantes/`; `tests/e2e/teams*.spec.ts`, `tests/e2e/meet*.spec.ts` | `PlatformAdapter` (só `readMeta()` para metadados: quem chama é o controlador), `LaunchOptions.routes` |
| seams (`elements`, `sources`, `output`) | `src/main-world/capture/seams.ts` (só as funções `install*Seam` desses três); variantes novas em `tests/fixtures/meet/variantes/` e `tests/fixtures/peer/variantes/`; `tests/e2e/seams*.spec.ts` | `Seam`, `notify` (o controlador já sincroniza o mixer na hora), `Originals`, `registry.isLocal/markLocal/isReceiverTrack` |
| modo aba | `src/background/tabcapture.ts`, `src/offscreen/tab.ts`, `tests/e2e/modo-aba*.spec.ts` | `createSession({ kind: 'aba' })`, `onPageSessionEnded`, `ensureOffscreen`/`sendToOffscreen`, `EXTENSION_ID` + `LaunchOptions.extraArgs` |
| durabilidade (downloads, recuperação por alarme) | `src/background/sessions.ts`, `idb.ts`, `gaps.ts`, `sink-host.ts`, `sink-downloads.ts`, `src/offscreen/blob.ts`, `tests/e2e/durabilidade*.spec.ts` | `sendToOffscreen`, `RECOVER_ALARM`, `DownloadsResult.downloadId` |
| interface e badge | `src/popup/**`, `src/options/**`, `src/background/badge.ts`, `src/background/ui-api.ts`, `src/background/reveal.ts`, `src/shared/recent.ts`, `src/shared/settings.ts` | `registerBadge`, `UiReq`/`UiResMap`, `canReveal` |
| vigia (ainda sem fatia: precisa de uma) | `src/content/vigia/**`, `src/background/vigia.ts`, `src/background/vigia-state.ts`, `tests/fixtures/vigia/**`, `tests/e2e/vigia*.spec.ts` | `waitTabSessionSaved`, `setAutoLeave`, `LaunchOptions.routes` (páginas próprias do vigia, sem depender de `tests/fixtures/teams/`) |

Compartilhados (fatia 1; só por emenda): `src/shared/**` fora os citados acima, `src/main-world/{install,hook.iife,session,bridge,originals}.ts`, `src/main-world/capture/{registry,mixer,recorder,arbitration}.ts`, `src/content/relay.ts`, `src/background/{index,offscreen-doc,info}.ts`, `src/offscreen/{offscreen,handlers}.ts`, `tests/helpers/**`, `tests/fixtures/{routes,call-runtime,peer-page}.ts`, `tests/fixtures/meet/page.ts`, `manifest.config.ts`, `vite.config.ts`, `package.json`.

**Vigia: a aba fecha depois de salvar.** A Emenda 2 dizia, na prosa, "espera ... ter todos os chunks até `lastSeq` gravados no IndexedDB", e, no teste, "a aba só fecha depois do `info.json` existir" (ESPEC AC18: "depois que a gravação daquela call foi salva"). Vale o segundo: `waitTabSessionSaved(tabId, 20_000)` (em `sessions.ts`) espera a sessão de página que a aba tem naquele momento ficar `salva` (helper ou downloads terminaram, `info.json` escrito) ou `descartada`; sem sessão, resolve na hora; passados 20 s, devolve `false` e o vigia fecha assim mesmo (o `tabs.onRemoved` finaliza com o que houver). O `vigia.ts` do SW já usa esta função. Dependência: o caso "a aba só fecha depois do `info.json`" precisa gravar, então no Teams ele espera a fatia dos adaptadores; no Meet dá para testar já.

**Ponte MAIN <-> ISOLATED por MessagePort.** Substitui "`window.postMessage({ __gravador__: 1, dir, msg })`" da seção Protocolo. Pela janela só passa o aperto de mão (`bridge:ready` do relay, `bridge:open` do MAIN com a porta transferida, `bridge:ack` já pela porta); chunks, diagnóstico e sessão vão pela porta, que os listeners de `message` da página não veem (AC14). O MAIN guarda as mensagens até o `bridge:ack` e só troca de porta se a atual não foi confirmada, então nada se perde se os dois mundos subirem em qualquer ordem. O relay aceita mensagens só da porta mais recente.

**Documento offscreen: um dono.** Só `src/background/offscreen-doc.ts` cria o documento (`ensureOffscreen()`, motivos `BLOBS`, `USER_MEDIA`, `AUDIO_PLAYBACK`; idempotente e seguro com chamadas simultâneas) e `sendToOffscreen(req)` manda a mensagem tipada abrindo o documento se preciso. Os handlers ficam um arquivo por fatia: `src/offscreen/blob.ts` (`offscreen:blob-url`, `offscreen:revoke`) e `src/offscreen/tab.ts` (`offscreen:tab-start`, `offscreen:tab-stop`); o roteador `src/offscreen/offscreen.ts` junta os dois e não muda. O offscreen é página da extensão: abre o mesmo IndexedDB `gravador` de `idb.ts`.

**Fim da sessão de página.** `onPageSessionEnded(cb)` (em `sessions.ts`) avisa `{ tabId, sessionId, reason }` quando uma sessão de página começa a finalizar (uma vez por sessão enquanto o SW vive; depois de um reinício pode repetir, então o ouvinte é idempotente). O modo aba assina dentro de `registerTabCapture()` e para a gravação da aba ("Para quando ... a sessão de página da aba terminar").

**Ouvintes no topo do SW.** `src/background/index.ts` chama, no carregamento, `registerSessionPorts`, `registerSessionAlarms`, `registerVigiaPorts`, `registerUiApi`, `registerTabCapture` e `registerBadge`. Cada fatia preenche o seu `register*` no arquivo dela e não edita `index.ts`: a recuperação por alarme cria `RECOVER_ALARM` (`'gravador:recuperar'`, o ouvinte já chama `recoverSessions()`); o badge preenche `handleNotificationClick` (cliques e botões das notificações já chegam lá).

**Controlador da sessão (`session.ts`).** Relê os metadados no fim (`readMeta()` antes do `session:end`, além de a cada 5 s) e assina `seams.onChange`: quando um seam chama `notify`, o mixer sincroniza na hora (agrupado, fora da pilha da página), sem esperar o polling de 1 s. Os adaptadores só implementam `readMeta()`; os seams só chamam `notify`.

**"Mostrar no Finder" pelo destino.** `RecentRecording.downloadId?: number` (reserva downloads) e `DownloadsResult.downloadId?: number`, que o `sessions.ts` copia para as últimas gravações. `UiReq` `ui:reveal` passa a ser `{ t: 'ui:reveal'; sessionId: string }`: o SW acha a gravação e usa o helper (`open -R`) ou `chrome.downloads.show(downloadId)` (`src/background/reveal.ts`). O popup mostra o botão quando `canReveal(rec)`.

**Originais capturados.** `Originals` ganhou `MessageChannel`, `portPostMessage`/`portStart`/`portAddEventListener`, `AudioWorkletNode`, `AudioDestinationNode`, `MediaStreamTrackGenerator`, `createMediaStreamTrackSource` e `mediaPlay`. Um seam pode capturar mais referências dentro de `seams.ts`, desde que seja durante a instalação (no `document_start`, antes de qualquer código da página), nunca depois.

**Regra 1 também na instalação.** `src/main-world/install.ts` (`installHook`) põe a captura dos originais e tudo o que vem depois dentro de `try/catch`: uma frame sem `MediaStream` ou `Document` não gera erro na página. `hook.iife.ts` só chama `installHook()`.

**Registro de PCs.** O registro guarda os PCs por `WeakRef` (o hook nunca segura vivo um PC que a página largou sem `close()`, como o descartável do Meet); os que já carregaram áudio remoto ficam também numa referência forte até fechar. O Proxy do construtor também corrige `RTCPeerConnection.prototype.constructor` para o Proxy, mantendo o invariante nativo `pc.constructor === window.RTCPeerConnection`.

**Lacuna no fim.** Se o `session:end` anunciou `lastSeq` e os chunks de `nextSeq` até ele não chegaram em 5 s, a finalização registra `{ fromSeq: nextSeq, toSeq: lastSeq }` em `lacunas` (`src/background/gaps.ts`), em vez de salvar como se estivesse completo.

**Harness de teste.**
- `launchWithExtension({ extraArgs, routes, defaultRoutes })`: flags a mais depois das padrão (ex.: `--allowlisted-extension-id=${EXTENSION_ID}`; `--disable-features` não, porque o Chrome só lê o último) e rotas a mais instaladas depois das padrão (têm precedência; `route.fallback()` devolve o pedido às padrão). `EXTENSION_ID` sai da chave versionada e o harness confere que é o ID do SW.
- Rotas padrão (`tests/fixtures/routes.ts`): `/__peer` em todos os hosts de call (o BroadcastChannel só fala com a mesma origem) e a reunião do Meet em `meet.google.com/<código>`. Cada variante é um arquivo: `tests/fixtures/meet/variantes/<nome>.js` e `tests/fixtures/peer/variantes/<nome>.js`, lidos a cada pedido; variante nova não edita nada compartilhado. A parte comum da página da call (microfone como envio, PC, sinalização) está em `tests/fixtures/call-runtime.ts`, com pontos de extensão em `sala.opts`.
- Ganchos de teste do SW em `__gravador.testing` (nunca armados pelo produto): `holdPersistAt(seq)` segura um chunk antes do IndexedDB para o teste derrubar o SW nessa janela (prova o "IndexedDB antes do ack"); `delayFinalize(ms)` atrasa a finalização para provar que a espera do vigia vai até `salva`.
- Variantes que já existem: `normal`, `sala-de-espera`, `so-construtor` (PC registrado só pelo Proxy) e `sem-audio` (exige o priming). A exclusão das faixas locais só aparece nos seams `elements`, `sources` e `output`: a fatia dos seams precisa de uma variante em que a página toca o próprio microfone por `<audio>` e por `createMediaStreamSource`, para essa exclusão ser testada.

## Emenda 5: contrato fechado para as fatias paralelas (06/10/2026)

Achados da segunda verificação da fatia 1. Esta emenda **substitui** o que estiver em conflito acima, inclusive a tabela de donos da Emenda 4.

**Quem é dono de quê (reconciliado com o plano das fatias).** Cada fatia mexe só nos seus arquivos. Mudar o que está na coluna "contrato" é emenda nova, não detalhe da fatia.

| fatia | arquivos dela | contrato que ela não muda sozinha |
|---|---|---|
| adaptadores (Meet endurecido, Teams) | `src/main-world/platforms/meet.ts`, `teams.ts` e testes de unidade deles; `tests/fixtures/teams/**`; variantes novas em `tests/fixtures/meet/variantes/`; `tests/e2e/teams*.spec.ts`, `tests/e2e/meet*.spec.ts` | `PlatformAdapter` (com `filterReceiverTracks`, abaixo), `LaunchOptions.routes` |
| seams e arbitragem (AC5) | `src/main-world/capture/**` (`seams.ts`, `arbitration.ts`, `mixer.ts`, `recorder.ts`, `registry.ts` e os testes deles); variantes novas em `tests/fixtures/meet/variantes/` e `tests/fixtures/peer/variantes/`; `tests/e2e/seams*.spec.ts` | as interfaces que `session.ts` e `install.ts` usam: `Seam`/`SeamSet`, `Registry` (`isLocal`, `markLocal`, `isReceiverTrack`, `remoteAudioTracks`, `onRemoteAudio`, `setTrackFilter`, `probe`), `Mixer`, o gravador; as regras 1 a 8; `mixer.test.ts` (regra 4) e `registry.test.ts` só podem ganhar casos, nunca perder |
| modo aba (AC12) | `src/background/tabcapture.ts`, `src/offscreen/tab.ts`, `tests/e2e/modo-aba*.spec.ts` | `createSession({ kind: 'aba' })`, `onPageSessionEnded`, `ensureOffscreen`/`sendToOffscreen`, o gancho `toggleTabCapture` |
| durabilidade (AC9 downloads, AC10) | `src/background/{sessions,idb,gaps,sink-host,sink-downloads}.ts`, `src/offscreen/blob.ts`, `src/content/relay.ts`, `host/**`, `tests/unit/gravador-host.test.ts`, `tests/e2e/durabilidade*.spec.ts` | o aperto de mão da ponte (`bridge:*`, abaixo), `Up`/`Down`, `HostReq`/`HostRes`, `waitTabSessionSaved`, `onPageSessionEnded`, `RECOVER_ALARM` |
| interface e badge (AC11, AC13, AC16) | `src/popup/**`, `src/options/**`, `src/background/{badge,ui-api,reveal}.ts`, `src/shared/{recent,settings}.ts`, `tests/e2e/interface*.spec.ts` | `UiReq`/`UiResMap`, `registerBadge`, `canReveal` |
| vigia (AC18, Emendas 2 e 3) | `src/content/vigia/**`, `src/background/{vigia,vigia-state}.ts`, `tests/fixtures/vigia/**`, `tests/e2e/vigia*.spec.ts` | `VigiaUp`/`VigiaDown`, `waitTabSessionSaved`, `setAutoLeave` |

Compartilhados (só por emenda): `src/shared/**` fora os citados, `src/main-world/{install,hook.iife,session,bridge,originals,wrap}.ts`, `src/background/{index,offscreen-doc,info,testing}.ts`, `src/offscreen/{offscreen,handlers}.ts` e `offscreen.html`, `tests/helpers/**`, `tests/fixtures/{routes,call-runtime,peer-page}.ts`, `tests/fixtures/meet/page.ts`, `tests/fixtures/meet/variantes/{normal,sala-de-espera,so-construtor,sem-audio,integridade}.js`, `tests/e2e/{contrato,fatia1,fatia1-queda,perfis,integridade}.spec.ts`, `manifest.config.ts`, `vite.config.ts`, `package.json`. Exceção: a fatia dos seams pode **acrescentar** linhas em `fx.fatos()` de `integridade.js` para cada API nova que embrulhar.

Dependências de ordem (não de arquivo): a variante `teams-elemento` dos adaptadores precisa do seam `elements`; o caso do vigia "a aba só fecha depois do `info.json`" no Teams precisa dos adaptadores.

**Filtro do adaptador sobre o conjunto.** `PlatformAdapter.acceptReceiverTrack(track, streams)` sai. Entra `filterReceiverTracks?(all: readonly RemoteAudioTrack[]): readonly RemoteAudioTrack[]`: recebe de uma vez as faixas remotas vivas de todos os PCs (sem repetição) e devolve as aceitas, o que permite a regra do Teams "se existir stream `mainAudio*`, só ele". O registro ignora itens que não estavam na entrada e, se o filtro lançar, vale a entrada inteira. `probe()` conta só as aceitas.

**Regra 1 para funções que devolvem promise.** `getUserMedia` e `getDisplayMedia` embrulhados devolvem a promise **derivada** (`then` original do realm, `Originals.promiseThen`), que resolve com o mesmo stream (já marcado como local antes de qualquer código da página vê-lo) ou rejeita com o mesmo motivo. Antes, um `p.then(marcar, noop)` na promise da página a marcava como tratada e calava o `unhandledrejection` dela. A identidade da promise não é observável pela página (cada chamada já devolve uma promise nova); o custo é um microtask a mais.

**Embrulhos como métodos (`src/main-world/wrap.ts`).** `replaceMethod`, `wrapSetter` e `asMethod` criam o embrulho como método abreviado de objeto: não é construtível (`new pc.addTrack()` lança `TypeError`), não tem `prototype` e copia nome, `length` e flags do descritor. Os seams usam este arquivo. Diferenças aceitas: `Function.prototype.toString` mostra o nosso código, e `addEventListener` vira propriedade própria de `RTCPeerConnection.prototype` (o nativo é herdado de `EventTarget.prototype`; embrulhar o de `EventTarget` faria toda escuta da página passar por nós, o que é pior).

**Ponte travada depois da confirmação.** O MAIN responde o `bridge:ack` com `{ t: 'bridge:confirm' }` pela porta, e daí em diante o relay ignora qualquer `bridge:open` (o MAIN nunca reabre uma porta confirmada; um open novo só pode vir de outro script da página e cortaria a sessão em silêncio). Antes da confirmação o relay ainda aceita um open novo, que é a corrida legítima entre os dois mundos no `document_start`. Resíduo aceito: um script da página escrito contra a extensão ainda pode postar um open entre o ack e o confirm, e os listeners de `message` da página veem a porta transferida no aperto de mão.

**Ganchos de teste por fatia (`src/background/testing.ts`).** `registerTestHooks({ nome: fn })`, chamado de dentro do `register*()` da fatia; `index.ts` expõe o registro em `__gravador.testing` e não muda mais por causa de gancho. Nome repetido lança. No teste: `swApi(sw).testing(nome, ...args)` e `swApi(sw).testingHooks()`. Já registrados: `holdPersistAt`, `heldPersistSeq`, `delayFinalize`, `noAudioAlertMs(ms | null)` (AC13 sem esperar 60 s) em `sessions.ts`; `toggleTabCapture(tabId)` em `tabcapture.ts` (o "gatilho de teste no SW" do modo aba); `markTabsOpenedBeforeInstall`, `notifyNoAudio`, `handleNotificationClick`, `setBadge` em `badge.ts`.

**API do popup numa aba.** `ui-api.ts` aceita mensagens de páginas da própria extensão abertas numa aba (`sender.url` começando com `chrome.runtime.getURL('')`), para o teste da interface abrir `src/popup/index.html` como página. Content scripts continuam fora (o `sender.url` deles é o da página da call).

**Vigia aplica a configuração na próxima leitura.** O content script do vigia escuta `chrome.storage.onChanged`: ligar o `autoLeave` com a call aberta conecta o Port na hora; desligar chega pelo `vigia:config` que o SW manda a todo Port conectado.

**Harness: o mesmo perfil de novo, queda e downloads** (`tests/helpers/browser.ts`).
- `harness.relaunch(opts?)`: fecha o Chrome e abre de novo no **mesmo** user-data-dir, com o mesmo helper e a mesma raiz; não regrava as configurações. `harness.crash()`: `SIGKILL` no processo principal do Chrome daquele perfil (queda de verdade, sem `pagehide` nem `onRemoved`). Juntos cobrem "Chrome fechou/caiu, salva na próxima abertura" (AC10). `LaunchOptions.base` reaproveita uma pasta de um launch anterior.
- `LaunchOptions.contextOptions` (o que o `launchPersistentContext` aceita, menos o que é do harness) e `beforeLaunch({ base, userDataDir })` para preparar o perfil antes de abrir.
- `LaunchOptions.downloads: true`: semeia `Default/Preferences` com `download.default_directory = <base>/downloads`, volta o download ao comportamento padrão do Chrome por `Browser.setDownloadBehavior { behavior: 'default' }` e confere com um download canário que o arquivo caiu na pasta temporária (senão para e diz onde caiu). Medido no CfT 151: o padrão do Playwright (`allowAndName`) troca o nome por GUID, e `allow` com `downloadPath` ignora o `filename` do `chrome.downloads` (salva `download.txt`); só o caminho acima respeita as subpastas. Também medido: um `data:text/plain` com nome `.json` vira `.txt`, então a durabilidade gera o Blob com o tipo certo (`application/json`, `audio/webm`). `harness.downloadsDir` diz onde olhar.
- Guardas no `close()`/`relaunch()`: nada pode aparecer em `~/Documents/Gravações de calls` nem em `~/Downloads/Gravações de calls`.
- `launchWithoutExtension()`: o mesmo Chrome, flags e rotas, sem a extensão (controle dos testes de integridade).

**AC14 com evidência que falha.** A parte comum das páginas falsas manda toda `securitypolicyviolation` (inclusive Trusted Types disparado por código nosso que o try/catch engoliu) para `fixture.errors` e cada rejeição não tratada para `fixture.unhandled`. `harness.pageErrors` junta os erros de console e as exceções das abas nos hosts de call. `tests/e2e/integridade.spec.ts` roda a variante `integridade` com e sem a extensão e exige a mesma energia medida pela própria página (1 dB), as mesmas assinaturas das APIs embrulhadas, a mesma rejeição não tratada e os mesmos erros. `tests/helpers/webaudio.ts` lê o grafo de WebAudio pelo CDP (todos os mundos) e o teste da fatia 1 exige que o mixer exista e que nada chegue a um `AudioDestination` (regra 4; o CDP informa `channelCount` do momento da criação, antes das opções, então ele não serve para reconhecer o mixer). Toda fatia que acrescenta gancho no MAIN world roda as variantes dela com `expect(h.pageErrors).toEqual([])` e `fixture.errors` vazio.

## Emenda 6: retorno dos embrulhos e contrato do vigia e da interface (06/10/2026)

Achados da terceira verificação da fatia 1, fechados antes de as seis fatias saírem da `main`, para nenhuma precisar editar arquivo compartilhado. Esta emenda **substitui** o que estiver em conflito acima. A tabela de donos da Emenda 5 continua valendo, com os acréscimos do fim desta emenda.

**Regra 1 conferida no navegador, não só na assinatura.** `fx.fatos()` da variante `integridade` passou a ser assíncrona (o teste faz `await fx.fatos()`) e ganhou dois grupos, avaliados do mesmo jeito com e sem a extensão:
- `retornos`, num PC de rascunho (o da call não é tocado): `getUserMedia` resolve um `MediaStream`; `addTrack` devolve um `RTCRtpSender` que está em `getSenders()`; `addTransceiver` devolve um `RTCRtpTransceiver` que está em `getTransceivers()`; `replaceTrack` devolve uma `Promise` (e troca a faixa); `MediaStreamTrack.clone` devolve outra faixa (id diferente, mesmo `kind`); `MediaStream.clone` devolve outro `MediaStream`; `pc.close()` devolve `undefined`. Sem a extensão todos valem `true` (o teste exige, para a comparação provar algo).
- `chaves`: `Object.keys` dos protótipos embrulhados e o for-in de um PC, ordenado.

`registry.test.ts` ganhou o caso "cada embrulho devolve o mesmo objeto que o original devolveu" (identidade, com originais falsos que devolvem objetos marcados) e o de exceção do original subindo igual. Prova de que os dois falham: com o embrulho do `addTrack` devolvendo `undefined`, a unidade falha e o ponta a ponta mostra `addTrackDevolveSender: false`. A fatia dos seams continua podendo **acrescentar** linhas em `fx.fatos()` (agora dentro de `retornos`/`chaves` ou ao lado) para cada API nova que embrulhar.

**Flags do descritor do método herdado.** `replaceMethod` (`src/main-world/wrap.ts`) copia `writable`/`enumerable` do protótipo que **tem** o método (`ownerDescriptor`), não só do próprio. Operações WebIDL são enumeráveis, então o `addEventListener` embrulhado em `RTCPeerConnection.prototype` continua aparecendo no for-in de um PC (antes sumia; o for-in do teste pegou). Diferença que continua aceita (Emenda 5): ele é chave própria de `RTCPeerConnection.prototype` e por isso aparece no `Object.keys` desse protótipo e muda de posição no for-in; o fixture tira só essa chave do `Object.keys(RTCPeerConnection.prototype)` e compara o for-in ordenado. Redefinir uma chave própria não muda a ordem, então os outros protótipos (inclusive os que a fatia dos seams vai embrulhar) são comparados sem filtro. `src/main-world/wrap.test.ts` cobre as flags.

**Popup: está chegando áudio agora (AC11).** `ActiveRecording` ganhou `audioNow: boolean` e `silentForMs: number | null`, preenchidos em `sessions.ts` por `liveAudio(diag, now)` a partir do último `session:diag`: `silentForMs` é o silêncio informado pela página somado à idade do diagnóstico (nunca negativa), e `audioNow` é `silentForMs <= AUDIO_NOW_MS` (10 s, exportado de `sessions.ts`). Sem diagnóstico ou sem nenhuma fala ainda: `audioNow: false`, `silentForMs: null`. `hasAudio` (já houve fala) continua. Uma página que parou de mandar diagnóstico deixa de aparecer "com áudio" sozinha.

**Modo aba acordado em todos os fins da página.** A sessão do modo aba pareada esperava a página, mas só era acordada quando a página ficava `salva`; descartada (curta) ou com falha ao salvar, o modo aba ficava `finalizando` para sempre. Agora o `finally` de `finalize()` da sessão de página chama `wakePairedTabSessions`, qualquer que seja o resultado. A decisão de esperar (`pairedPageState`) usa o estado em memória da página quando existe (espera se ela grava ou está finalizando agora) e o IndexedDB quando o SW reiniciou. Página salva: o arquivo entra na pasta dela, como antes; descartada ou com falha: o modo aba salva na pasta própria, e a página com falha fica para a recuperação. Se a página termina enquanto o modo aba ainda está finalizando, o modo aba é marcado (`pairedWake`) e roda de novo ao terminar. Testado em `src/background/sessions.test.ts` (IndexedDB, helper e downloads falsos), que falha nos casos "descartada", "falhou ao salvar" e "os dois fins juntos" com a versão anterior.

**Vigia e interface em paralelo.** As duas fatias não editam os arquivos uma da outra; o que uma precisa da outra é isto:
- **Popup lê e comanda o vigia só por funções de `src/background/vigia.ts`** (assinaturas fixas; o corpo é da fatia do vigia): `vigiaTabState(tabId): VigiaTabState`, `vigiaStatuses()` e `vigiaCommand(tabId, 'sair-agora' | 'desligar-nesta-call'): boolean`. `ui-api.ts` não importa mais `vigia-state.ts`.
- **`UiReq`:** `{ t: 'ui:vigia-status'; tabId }` responde `VigiaTabState { connected, disabledForCall, status }` (o popup abre sobre uma aba, mesmo sem gravação). Os comandos continuam `ui:vigia-sair-agora` e `ui:vigia-desligar` (já existiam; não viraram um `ui:vigia-cmd` para não trocar nome à toa). `UiState.vigia` e `ActiveRecording.vigia` continuam. `disabledForCall` vale até a aba navegar: um Port novo do vigia na aba zera.
- **`VigiaStatus.platform`** (`'meet' | 'teams'`), validado pelo zod: o popup mostra a fonte da contagem conforme a plataforma.
- **"Não consegui sair com segurança" no Meet** é `{ t: 'vigia:nao-consegui-sair'; motivo }` (já estava em `protocol.ts` desde a fatia 1, faltava na lista da Emenda 2). O SW desfaz a marca de saída automática (`setAutoLeave(tabId, null)`) e mostra a notificação "Não consegui sair da call sozinho: confirme na aba.".
- **`saidaAutomatica` no info.json:** `vigia:saindo` chama `setAutoLeave(tabId, { motivo, pico, na, em })` (`sessions.ts`), que grava `SessionRecord.autoLeave` no IndexedDB; `buildInfo` (`info.ts`) escreve `saidaAutomatica` e a finalização troca `motivoFim` por `saida-automatica` (menos em sessão interrompida). `setAutoLeave` aceita `null` para desfazer. Divergência declarada da sugestão de o `info.ts` ler o `vigia-state.ts`: esse estado é só memória, some quando o SW reinicia e quando o Port do vigia cai (a aba fecha antes de o info.json ser montado), e o IndexedDB não some.
- **Configurações** (`Settings`, por perfil): `profileLabel: ''`, `autoLeave: false`, `vigiaIndicador: true` e `vigia: { intervaloSeg: 5, fracao: 0.3, minimo: 2, picoParaQueda: 4, confirmacoes: 4, faltasParaFim: 3 }`. `src/shared/settings.test.ts` lê os seis números de `docs/referencia/vigia-original.js` e exige que batam.
- **Meet, de novo:** o vigia **nunca abre o painel de pessoas sozinho** (`abrirPainel` no Meet devolve `false` sem clicar) e conta por `[data-avatar-count]`; a lista do painel só vale se ele já estiver aberto, e blocos de vídeo nunca disparam saída (Emenda 3). O comentário de `src/content/vigia/contagem.ts` foi alinhado com isso.

**Donos, acréscimos à tabela da Emenda 5.** `src/background/sessions.test.ts` é da durabilidade; `src/shared/settings.test.ts`, da interface; `src/main-world/wrap.test.ts` é compartilhado e só ganha casos. O contrato que nenhuma fatia muda sozinha passa a incluir `ActiveRecording.audioNow`/`silentForMs`, `AUDIO_NOW_MS`, `VigiaTabState`, `VigiaStatus.platform`, `ui:vigia-status` e as três funções de `vigia.ts` acima.

## Emenda 7: integração das seis fatias (06/10/2026)

As seis fatias (seams, adaptadores, durabilidade, modo aba, interface, vigia) entraram na `main` nessa ordem, cada uma com `merge --no-ff`. Nenhuma teve conflito de texto: as tabelas de donos das Emendas 5 e 6 seguraram. Esta emenda registra o que a integração mudou no contrato, os pedidos de contrato das fatias (aceitos e recusados) e os donos dos arquivos novos. Ela **substitui** o que estiver em conflito acima.

**Conflito de comportamento entre fatias.** Com o seam `elements` de verdade (fatia dos seams), a gravação do Teams passou a começar por `elements`, que é o primeiro da prioridade do Teams (seção "Arbitragem"): o `<audio>` do body toca só o `mainAudio`. O teste da fatia dos adaptadores tinha sido escrito com o seam ainda vazio e esperava `fonteInicial: 'receivers'`. Vale a prioridade do contrato: `tests/e2e/teams.spec.ts` agora espera `elements` (o 660 Hz do `dominantSpeaker` continua 30 dB abaixo, mas isso só mostra que o `<audio>` toca o `mainAudio`; não prova o filtro dos receptores, ver a Emenda 8).

**Modo aba (AC12).**
- `tests/e2e/contrato.spec.ts` confere o modo aba implementado: `toggleTabCapture` e `ui:tab-capture` numa aba que não existe devolvem `{ ok: false, error: 'aba não encontrada' }` e não abrem sessão; o manifesto tem `activeTab`.
- `OffscreenReq` `offscreen:tab-stop` ganhou `reason?: EndReason` (vai no `session:end` que o offscreen manda; sem ele, `parado-pelo-usuario`). O tipo de interseção em `tabcapture.ts` e o cast em `tab.ts` saíram.
- **O Port do offscreen se liga à sessão no início.** O offscreen manda `session:resume` (com `localId` igual ao `sessionId`) logo depois de começar a captura e de novo a cada reconexão, antes dos pendentes. No SW, cada Port retoma só o seu tipo (`gravador:aba` as sessões `aba`, `gravador:sessao` as de página) e o resume de uma sessão `aba` não toca no índice das sessões de página da aba (`activeByTab`); antes, por isso, o offscreen não mandava resume e o Port só se ligava no primeiro chunk. Assim o botão parar do popup no primeiro segundo chega ao offscreen e a aba não fica capturada sem sessão. Recusado o caminho alternativo (`stopSession` de uma sessão `aba` mandar `offscreen:tab-stop`): `sessions.ts` teria de importar o modo aba (ciclo de módulos), e o Port já é o canal de parar de todas as sessões.
- **REC na aba.** `cleanup()` só apaga o badge (e devolve `autoDiscardable`) quando nenhuma outra sessão `gravando` resta na aba. A fatia da durabilidade já tinha feito isso; agora há teste (`sessions.test.ts`, "o modo aba sem par termina durante a call").
- **Outro site.** Modo aba numa aba fora dos hosts das calls levava a pasta "(Meet)" e "Sem título". Decisão: as duas coisas, porque resolvem problemas diferentes. A permissão `activeTab` dá título e URL da aba, e o Chrome a concede na mesma invocação que já libera a captura (atalho, clique no ícone e botão do popup); ela não pede nada na instalação e não vale fora do gesto, então não amplia o acesso da extensão. E um valor de plataforma para o rótulo: `RecordingPlatform = Platform | 'outro'` (rótulo "Outro site"), usado em `SessionRecord`, `NewSession`, `ActiveRecording`, `RecentRecording`, `InfoJson.plataforma` e nos nomes. `Platform` continua `meet | teams`: o conteúdo das calls (`session:start`, `VigiaStatus`) nunca fala `outro`, e o zod dele não mudou. `platformOfUrl` devolve `outro` também sem URL, porque os hosts das calls sempre dão a URL (host_permissions). O gatilho de teste não é gesto do usuário, então nos testes ponta a ponta uma aba de outro site continua "Sem título (Outro site)"; título e URL reais fora dos hosts só a verificação manual prova.
- **Harness:** `LaunchOptions.tabCapture` em `tests/helpers/browser.ts` (sem `--mute-audio` e sem `--use-fake-ui-for-media-stream`; com `--auto-accept-camera-and-microphone-capture`, `--disable-audio-output` e `--allowlisted-extension-id`), mantida no `relaunch()`. A troca temporária de `chromium.launchPersistentContext` em `modo-aba.spec.ts` saiu.

**Durabilidade.** `InfoJson` ganhou o irmão `OrphanInfoJson` (`plataforma: null`, `titulo: 'Gravação recuperada'`, `semRegistro: true`, status e motivo `interrompida`), e `HostReq` `finalize` passou de `info: object | null` para `info: InfoJson | OrphanInfoJson | null`: o `finalizeOrphan` é conferido pelo tsc. `HostStagingEntry` ganhou `createdAt?`/`updatedAt?` (ms), que o helper já mandava e a recuperação de órfãos usa; a interseção local em `sessions.ts` saiu.

**Sobra do staging com a sessão em memória.** A primeira passada completa da suíte integrada falhou uma vez em `durabilidade-downloads.spec.ts` ("o helper some no meio e não volta"): a sobra do staging ficou no helper. Causa: uma mensagem atrasada do relay (diagnóstico ou chunk reenviado) depois de a sessão ser salva relê o registro do IndexedDB para a memória do SW, e `recoverStaging` pulava toda sessão em memória. Agora pula só a que ainda está aberta; a salva ou descartada segue para a regra de sempre (apagar a sobra). Teste de unidade novo em `sessions.test.ts`, que falha com a regra antiga.

**Vigia: "Desligar nesta call" vale até a próxima call.** Novo `VigiaUp` `{ t: 'vigia:nesta-call'; desligado: boolean }`, validado pelo zod. O content script manda ao conectar (o Port pode ser novo só porque o SW reiniciou ou o `autoLeave` foi desligado e ligado) e a cada mudança; o SW espelha em `VigiaTabState.disabledForCall`, e a verdade fica com o content script. Parado (pelo popup, ou porque desistiu no diálogo ambíguo do Meet), o vigia não conta nem sai: só lê se está em call, no mesmo intervalo. A call acabou quando faltam `faltasParaFim` leituras seguidas (a mesma régua do fim no script); a primeira leitura em call depois disso é uma call nova, e o vigia recomeça do zero e manda `desligado: false`. Uma queda mais curta é a mesma call (a contagem zera). Com o vigia parado, o SW apaga a última leitura da aba (ela podia ser "saindo"). O popup diz "Desligado nesta call. Volta a valer na próxima call desta aba.". Recusada a alternativa de só trocar o texto do popup para "até recarregar a aba": no Meet (Entrar de novo) e no Teams (aplicação de página única) a call seguinte acontece no mesmo documento, e o vigia ficaria desligado sem o usuário saber.

**Registrado sem mudar código (pedidos só de documentação).**
- Seam `output`: o grafo da página guarda só as arestas de saída, num `WeakMap` pela origem; os nós que a página ligou ao destino ficam por `WeakRef`; um `connect` comum custa O(1). Um `MediaStreamAudioDestinationNode` da página alimentado pelo microfone é marcado como local para sempre (com `notify`), de propósito: desmarcar trocaria um risco do AC3 por um caso raro do AC5.
- Badge do AC16: o ↻ sai quando um content script da frame do topo abre um Port, e isso depende de o MAIN world mandar `hello` no `DOMContentLoaded` de todo documento dos hosts das calls e de o relay conectar nessa primeira mensagem. Uma fatia que deixe o `hello` preguiçoso (só quando a call começa) quebra o AC16; o teste ponta a ponta do AC16 pega.

**Testes que a integração destravou ou acrescentou** (cada um conferido falhando com o código guardado mutado):
- `teams.spec.ts` "caminho WASM" (era `fixme`): falha com o seam `elements` vazio.
- `vigia.spec.ts` "Teams gravando" (era `fixme`), sobre a reunião falsa dos adaptadores com a variante nova `tests/fixtures/teams/variantes/vigia.js`: falha com o vigia fechando sem esperar salvar. E "Desligar nesta call vale até a próxima call": falha sem a volta na call nova, com as quedas curtas somando e com o SW sem espelhar.
- `meet.test.ts`: memória por código de reunião (M15) e o próprio nome tirado dos participantes já acumulados (M12).
- `interface.spec.ts`: a API do popup recusa mensagens de content script (M19), só o Port da frame do topo tira o ↻ (M22, com um iframe), e o popup usa o `confirmacoes` do perfil (M20).
- `src/offscreen/tab.test.ts`: a faixa da captura terminando sozinha fecha a gravação (o caminho `ended`, que o ponta a ponta não separa do `tabs.onRemoved`), o resume no início e o motivo do tab-stop.
- `src/background/tabcapture.test.ts`: a busca no IndexedDB do `tabSessionOf` (M7b), o registro que sobrou num tabId reusado, os dois toggles juntos e a plataforma `outro`.
- `modo-aba.spec.ts`: o botão "Gravar esta aba (modo aba)" do popup grava a aba atual e o mesmo botão para; parar antes do primeiro chunk.
- `sessions.test.ts`: resume do modo aba (Port certo, sem virar a sessão de página), o REC na aba e a sobra do staging de uma sessão salva que voltou à memória.
- `simultaneas.spec.ts` (AC4, que ainda não tinha teste com três abas): três calls do Meet no mesmo perfil, com 440, 660 e 880 Hz, dão três pastas e cada arquivo só com o seu tom; falha com os chunks de uma aba entrando na sessão de outra.

**Donos, acréscimos à tabela da Emenda 5** (com os da Emenda 6):

| fatia | arquivos novos |
|---|---|
| seams | `src/main-world/capture/{page-graph,seam-elements,seam-output,seam-sources,seam-util}.ts`, `seams.test.ts` |
| adaptadores | `src/main-world/platforms/{meet,teams}.test.ts`, `tests/fixtures/teams/**` (menos `variantes/vigia.js`), `tests/fixtures/meet/variantes/{metadados,pedindo-para-participar,sem-pc}.js` |
| durabilidade | `src/background/sink-downloads.test.ts` |
| modo aba | `src/background/tabcapture.test.ts`, `src/offscreen/tab.test.ts` |
| interface | `src/background/{badge,reveal}.test.ts`, `src/popup/format.ts` e `format.test.ts`, `src/options/form.ts` e `form.test.ts` |
| vigia | `src/content/vigia/{contagem,regua}.test.ts`, `src/content/vigia/dialogo.ts`, `tests/fixtures/teams/variantes/vigia.js` (variante da reunião dos adaptadores usada só pelo vigia) |

O contrato que nenhuma fatia muda sozinha passa a incluir `RecordingPlatform`, `OrphanInfoJson`, `HostStagingEntry.createdAt`/`updatedAt`, `OffscreenReq` `tab-stop.reason`, `vigia:nesta-call`, o resume do Port `gravador:aba` e `LaunchOptions.tabCapture`.

## Emenda 8: correções da verificação da integração (07/10/2026)

A verificação da `main` integrada (rodada 1) achou um problema grave e quatro menores. Nenhum muda tipo, mensagem ou zod: esta emenda registra testes novos, uma correção de tratamento de erro nas configurações e uma frase errada da Emenda 7. Ela **substitui** o que estiver em conflito acima.

**Filtro dos receptores do Teams sem teste (grave).** Depois da resolução do conflito da Emenda 7, o v2 grava pelo seam `elements`, e o `<audio>` da página só toca o `mainAudio`: tirar o `filterReceiverTracks: filterMainAudio` do adaptador passava em toda a suíte. O filtro continua valendo sempre que o `elements` fica sem fonte (o Teams sem `<audio>` para a call, ou o elemento trocado no meio), e sem ele os receptores misturam o `mainAudio` com os `dominantSpeaker-*` e a gravação repete palavras. Agora:
- `tests/fixtures/teams/variantes/sem-elemento.js` (fatia dos adaptadores): a reunião v2 sem `<audio>`, com as duas faixas do participante chegando aos receptores.
- `tests/e2e/teams.spec.ts` "sem `<audio>` na página": `fonteInicial` e `fonteFinal` `receivers` e o 660 Hz 30 dB abaixo do 440 em toda janela. Sem o filtro, o 660 Hz chega a -6,5 dBFS e o teste falha.
- `src/main-world/install-wiring.test.ts` (compartilhado, como o `install.ts` que ele confere, entra na lista de compartilhados da Emenda 5): o `installHook` entrega ao `registry.setTrackFilter` o filtro do adaptador do host (nos três hosts do Teams, e `undefined` no Meet), e `teamsAdapter.filterReceiverTracks` é o `filterMainAudio`. Falha tirando o filtro do adaptador ou a ligação no `install.ts`.

**Resume do offscreen na reconexão.** A Emenda 7 dizia que o offscreen manda `session:resume` no início e a cada reconexão, mas só o início tinha teste. `src/offscreen/tab.test.ts` ganhou os dois caminhos da reconexão: pelo timer (o Port volta antes do primeiro chunk e a primeira mensagem é o resume) e pelo chunk que acha o Port caído (resume e depois o chunk). Os dois falham sem o `bind` do `resync`.

**Configurações (AC9).**
- Uma rejeição do `uiCall` (a mensagem que não chega ao SW) em "Usar esta pasta", "Escolher..." e "Salvar" vira a resposta de falha da API (`asFailure` em `src/options/Options.tsx`, o mesmo padrão do botão do modo aba no popup) e aparece na tela; antes ficava uma promessa sem tratamento e a página muda.
- `tests/e2e/interface.spec.ts` "Escolher... aplica a pasta do seletor": a resposta do `ui:choose-folder` é trocada só naquela página (o `osascript` do helper abriria uma janela de verdade), e o resto (`check-root` e `set-root` no helper) é o de verdade; cancelar não mostra erro; as rejeições aparecem na tela sem `pageerror`; e, depois de `harness.relaunch()`, a raiz do `config.json`, as configurações do perfil, a tela de configurações e o popup mostram o que ficou salvo. Falha sem a correção acima. O seletor do macOS em si continua só na verificação manual.

**Modo aba, "Outro site".** O teste do botão do popup confere a pasta "(Outro site)" pelo caminho sem URL do `platformOfUrl` (o SW não vê a URL de `outro-site.test`); o ramo por host é guardado pelo `tabcapture.test.ts`. Ficou dito no comentário do teste, sem mudar o que ele confere.

**Travessões no histórico.** Dois commits da fatia 1 tinham os caracteres de travessão e meia-risca num regex do separador de título do Meet; a `main` não tem nenhum (o regex usa os code points escapados). Fica como está (corrigido na Emenda 9): os caracteres eram dado funcional do regex e dos textos de teste, não prosa, e a `main` de hoje usa os code points escapados.

## Emenda 9: segunda verificação da integração (07/10/2026)

A rodada 2 da verificação da `main` achou quatro problemas menores e um defeito real que o teste novo revelou. Nenhum muda tipo, mensagem ou zod. Esta emenda **substitui** o que estiver em conflito acima.

**Dados da call depois de a SPA sair da URL de call (AC6, AC8).** Ao navegar por `pushState` para fora da URL do Meet, a releitura do fim em `finish()` (`src/main-world/session.ts`) lia a página nova: o `info.json` saía com `codigo` vazio e a URL e o título da aba da página para onde foi. Agora a releitura do fim só acontece se `adapter.matchesUrl(location)` ainda vale; fora da URL de call vale a última leitura feita na call. No Teams o `matchesUrl` é pelo host, então nada muda lá.

**Navegar para fora (AC6).** `tests/e2e/meet.spec.ts` ganhou os dois caminhos, com 13 s de call gravando antes de sair:
- documento novo (`about:blank`): salva em até 10 s com `motivoFim` `pagehide`, sem lacuna, e o arquivo perde no máximo 6,5 s do fim (o último chunk de 5 s mais o atraso de 1,5 s do mixer, o "no máximo os últimos ~5 s" do AC10), medido contra o relógio do teste;
- `pushState` para `/landing`: salva em até 10 s com `motivoFim` `navegou`, com `codigo`, `tituloDaAba` e pasta da call, e perde no máximo 1,5 s.
Medido: o `session:end` que o `pagehide` do MAIN world manda não chega ao SW antes de o documento sair. Quem salva nesse caminho é o `onDisconnect` do Port no SW (os 3 s de `DISCONNECT_GRACE_MS`, com o motivo `pagehide`), como a seção "Fim" já previa ("se não der tempo, o SW finaliza pelo `onDisconnect`"). Por isso tirar a linha do `pagehide` em `session.ts` não falha o teste, e tirar o `scheduleFinish` do `onDisconnect` falha (salva em 20 s). O envio do MAIN world fica como melhor esforço.

**Configurações (AC9).** O teste "Escolher..." de `tests/e2e/interface.spec.ts` também rejeita o `ui:set-root` (com o `check-root` de verdade passando) e o `ui:save-settings`, e espera "Não foi possível salvar a pasta: ..." e "Não foi possível salvar: ..." sem `pageerror`, com a raiz e o perfil sem mudar. Falha sem o `.catch(asFailure)` de cada um.

**Limite de 20 s para fechar a aba (AC18).** `src/background/sessions.test.ts` ganhou "espera para fechar a aba": sem sessão e com a sessão salva, `waitTabSessionSaved` devolve `true`; com a sessão ainda gravando e com a finalização travada em "finalizando" (`testing.delayFinalize`), devolve `false` no limite. Falha (estoura o tempo do teste) sem a checagem do limite. A falha ao salvar, como estava nesta emenda: a espera que já tinha começado (o caso normal do vigia, que pede para fechar antes de a gravação terminar) via a sessão em "finalizando" e só devolvia `false` no limite de 20 s; só uma espera começada depois da falha devolvia `true` na hora, porque a falha tira a sessão de `activeByTab`. Nos dois casos os chunks ficam no IndexedDB para a recuperação. A frase anterior desta emenda dizia que a falha devolvia `true` na hora em todo caso, o que o código não fazia; a Emenda 10 troca os dois caminhos por `false` na hora.

**Travessões no histórico.** A frase da Emenda 8 dizia "histórico publicado", mas o repositório não tem remoto. O motivo real de não reescrever `28fd645` e `814358d` está corrigido lá.

## Emenda 10: revisão de uso real (07/10/2026)

Uma revisão olhou o que vai dar errado no uso de todo dia (horas de call, até três abas em perfis diferentes, o Chrome de marca 154 em vez do Chrome for Testing 151) e que a suíte não mostrava. Esta emenda registra as mudanças de contrato e de comportamento que vieram dela. Ela **substitui** o que estiver em conflito acima. Cada correção tem um teste que falhava antes dela (conferido com o código antigo ou com a mutação indicada).

**Configurações chegam à aba aberta com o SW dormindo (AC15).** O MV3 para o SW ocioso uns 30 s depois do último evento, e o relay de uma aba sem gravação não tem Port. O `broadcastSettings` só alcançava os Ports da vida atual do SW, então religar o `autoMeet`/`autoTeams` não chegava às abas já abertas, e a call seguinte delas não era gravada. Agora o relay escuta `chrome.storage.onChanged` e manda `{ t: 'settings' }` ao MAIN world (só `false` explícito desliga). Teste: `tests/e2e/uso-real.spec.ts` (para o SW pelo CDP, como o MV3 faria).

**Meet: continuar na call é mais frouxo que começar (AC1, AC6).** `PlatformAdapter.stillInCall?(probe)` (novo, opcional) decide se a call continua enquanto grava; sem ele vale `isInCall`. `Probe.reconnectingWithAudio` (novo): algum PC que já esteve `connected`, com receptor de áudio vivo, está em `disconnected` ou `connecting`. No Meet, `stillInCall` = URL da reunião, botão de sair, sem a tela de saída e (`connectedWithLiveAudio` ou `reconnectingWithAudio`). Os ícones de legenda e chat continuam exigidos só para começar (separam a sala de espera); numa janela estreita o Meet os leva para o menu "mais opções", e a gravação acabava em 15 s como `fora-da-call`. Uma queda de VPN ou de Wi-Fi de mais de 15 s com o ICE se recuperando também não divide mais a call em duas gravações. O fim por `pc.close()` sem outro PC com áudio em 5 s continua como era (ver "Não feito"). O teste "PC que fecha e volta" de `meet.spec.ts` mudou de propósito: tirar o ícone de legenda agora tem de manter a gravação, e o "em call falso por 15 s" é provado tirando o botão de sair.

**Vigia.**
- `ContagemPlataforma.emCall(jaNaCall?)`: depois de a rodada ver a call, o Meet não exige mais os ícones (a mesma razão acima; com o `autoLeave` ligado, o vigia fechava a aba no meio da call). Parado nesta call, a ausência também é lida assim.
- Vigia órfão: com a extensão recarregada, atualizada ou desligada, o content script antigo continuava com timers e configuração congelada, sem Port, e saía da call sem que "Desligar nesta call" ou desligar o `autoLeave` chegassem nele. Agora ele confere `chrome.runtime.id` antes de cada leitura e de cada clique e, órfão, para de vez. Uma cópia nova na mesma aba avisa a antiga pelo evento `gravador:vigia-novo` no `document` (o `window.__vigia` do script).
- Pico recomeça quando a call some por pelo menos uma leitura e volta, ou quando o código da reunião do Meet muda: uma sala de grupo de 4 no mesmo documento herdava o pico de 20 da reunião principal e saía em 20 s. Recomeçar só deixa a saída mais cautelosa. Uma troca de sala sem nenhuma leitura fora da call ainda herda o pico.
- Meet, painel de pessoas: com seções (`[role="region"]`), conta só a de quem está na call (pelo rótulo localizado; uma seção só vale ela; várias sem achar a da call não contam). As linhas de "Aguardando para participar" e "Também convidados" têm a mesma marcação e inflavam o pico. Função pura `linhasDasSecoes` em `contagem.ts`.
- `vigiaCfgSchema` recusa uma regra que sairia de uma call no pico: `minimo < picoParaQueda` e `fracao < 1` (com isso `limite(p) < p` para todo `p >= picoParaQueda`). O formulário mostra a mensagem; uma combinação guardada assim volta aos números do script nos três campos da regra (`normalizeSettings`).
- O vigia sai como IIFE autocontido (`standaloneFiles` do crxjs, como o relay): sem `import()` de arquivo com hash e sem `web_accessible_resources` (ver "Pasta estável").

**IndexedDB que falha (AC10).** `onChunk` não avança mais `nextSeq`, `bytes`, `lastChunkAt` nem `gaps` antes de o chunk estar gravado: tenta de novo (0,3 s, 1 s e 2 s) e, se não der, desfaz o avanço, não manda `chunk:ack`, guarda o erro em `lastError` e derruba o Port daquela frame (`Runtime.awaitingResend`). O relay reconecta e reenvia em ordem tudo o que não teve ack, como depois de um SW que reiniciou; até lá, os chunks seguintes não têm ack nem viram lacuna. Antes, um chunk que falhava sumia sem lacuna, e sem o chunk 0 (o cabeçalho EBML) o arquivo não tocava, com o `info.json` dizendo `concluida`. `idb.ts` esquece a conexão que fechou sozinha (`onclose`) e reabre uma vez numa transação que encontra a conexão fechando. `onStart` tenta o `createSession` três vezes e, sem jeito, responde `session:rejected` com `other` (antes o MAIN world ficava sem resposta e gravava a call inteira no vazio).

**Streaming volta durante a call (AC6).** `hostDirty` voltava a `false` nunca: depois de um reinício do SW, de um append que estourou o tempo ou de uma sessão começada em downloads com o ping em cache, o resto da call ficava só no IndexedDB e o fim reenviava tudo, um append por vez (cerca de 1400 numa call de 2 h, medido em 10,7 ms cada só no helper). Agora `maybeCatchUpHost` completa o helper a partir do IndexedDB na fila do helper, durante a call, e volta a mandar cada chunk (no máximo uma tentativa a cada 15 s depois de uma que chegou ao helper). Uma sessão que começou em downloads passa para `host` quando o helper responde. Com lacuna, o arquivo continua sendo refeito do zero no fim.

**Destino no início.** O sink é `host` só com `ping.ok && ping.writable`; uma raiz sem permissão ou num disco desconectado começa em downloads.

**Helper.**
- Finalize idempotente: em vez de apagar o índice da sessão, o `finalize` grava nele uma lápide (`done`, `finalPath`, `finishedAt`; some depois de 30 dias, no `list-staging`). `begin`, `finalize` e `discard` de uma sessão com lápide devolvem `{ done: true, path }` (o `finalize` devolve `{ path }`) sem criar staging nem apagar nada. O SW, no `flushToHost`, usa a pasta da lápide e marca `salva` sem reenviar. Antes, o SW que morria entre o finalize do helper e o "salva" (Cmd+Q logo depois de sair da call) criava uma segunda cópia `X (2)`. O índice também guarda `target` logo depois de reservar a pasta; um finalize interrompido antes do `info.json` continua na mesma pasta.
- `readFrames(stream, onMessage, onEnd, concurrent)`: `choose-folder` e `reveal` rodam fora da fila serial e respondem quando terminam (as respostas já levam o `id`). Com o seletor do macOS aberto, os appends (15 s) e o ping (5 s) da gravação em andamento do mesmo perfil esperavam atrás dele.
- Erros do sistema de arquivos na escolha da pasta em português, com o código entre parênteses (`friendlyFsError`: sem permissão, caminho que passa por um arquivo, só leitura, cheio, disco desconectado).
- O helper confere se foi chamado direto comparando os caminhos reais (um caminho com symlink, como `/var` -> `/private/var`, fazia o processo sair sem responder).

**Instalação (substitui "instalar.mjs gera um wrapper host/gravador-host.sh" da seção Helper).** `npm run instalar` copia `gravador-host.mjs` e escreve o wrapper em `~/Library/Application Support/gravador-de-calls/bin/` (com `--wrapper`, na pasta dele; é o que os testes usam). O Chrome de marca é quem o macOS (TCC) responsabiliza pelo helper, então nada do que ele executa pode ficar em `~/Documents`; e mover o repositório não quebra mais. O wrapper tenta o node da instalação (`--node`, padrão `process.execPath`), depois `/opt/homebrew/bin/node`, `/usr/local/bin/node`, o default do nvm e o node do PATH; sem nenhum, escreve o motivo no log e sai com 127. O stderr vai para `--log`, por padrão `~/Library/Logs/gravador-de-calls/helper.log`. Não é preciso recarregar a extensão depois de instalar (o ping tem cache de 15 s). `npm run desinstalar` tira também a cópia do helper. `src/shared/helper-status.ts` (`helperProblem`) separa, no popup e nas configurações, "não instalado" (o Chrome não acha o manifesto), "instalado, mas não abre" (com o erro do Chrome e a instrução de reinstalar) e "sem permissão na pasta".

**Pasta estável da extensão.** `npm run publicar` (`scripts/publicar.mjs`) faz o build e troca a cópia inteira em `~/Library/Application Support/gravador-de-calls/extensao`, que é a pasta que os perfis carregam. O `dist/` de trabalho é apagado e reescrito com nomes novos por todo build (inclusive o do `test:e2e`) e servido por localhost no `npm run dev`; o carregador do vigia fazia `import()` de um arquivo com hash que deixava de existir, e o "sair sozinho" morria calado nas calls novas dos três perfis. Sem recurso acessível à página (`web_accessible_resources` vazio), uma página das calls também não acha mais a extensão por uma URL fixa nem lê o código e os mapas dela.

**Badge e popup.**
- `clearRecordingBadge(tabId)` (em `badge.ts`, usado pelo `cleanup` de `sessions.ts`): o fim de uma gravação tira o REC, mas mantém o ↻ se a aba está marcada, lendo a lista na mesma fila das escritas de `markTabsOpenedBeforeInstall`. Recarregar a extensão no meio da call fechava a gravação na recuperação e apagava o ↻ que o `onInstalled` tinha acabado de pôr. O botão da notificação passou a "Recarregar a aba (sai da call)".
- `UiState.reloadTabs` (abas com ↻): o popup aberto sobre uma delas diz que ela não grava até recarregar.
- `UiState.pendingSaves: PendingSave[]` e `UiReq` `{ t: 'ui:retry-saves' }` (resposta `{ ok, pending }`): gravações que terminaram e não foram salvas (helper e downloads falharam) aparecem no popup com o motivo e "Tentar agora". O ícone ganha um "!" âmbar global (`setSaveWarning`) e uma notificação sai na primeira falha (`notifySaveFailed`). Antes, o REC sumia e parecia salvo.

**Espera para fechar a aba (substitui a última frase da Emenda 9).** `waitTabSessionSaved` devolve `false` assim que uma tentativa de salvar termina com falha, tanto para a espera que já tinha começado quanto para uma que começa depois (a sessão com falha é achada mesmo fora de `activeByTab`). O vigia fecha a aba, e os chunks continuam no IndexedDB para a recuperação.

**Dados da call no perfil.** Uma gravação descartada por ser curta perde `meta` e `diag` na hora (e `session:meta`/`session:diag` atrasados de uma sessão salva ou descartada são ignorados). A recuperação apaga os registros `salva` e `descartada` com mais de 7 dias, depois de já ter limpado as sobras de staging deles na mesma passada.

**Configurações.** O nome do perfil é salvo ao sair do campo (só ele; o resto continua no Salvar), sair da página com mudanças pendentes pede confirmação, e um aviso pede para fixar o ícone enquanto `chrome.action.getUserSettings().isOnToolbar` for falso.

**Teams.** `stripTeamsTitle` tira as seções do aplicativo do Teams v2 (Chat, Calendário, Atividade, Equipes, Chamadas, Reunião...) e a contagem de não lidas do título da aba; o que sobrar é o título, e nada sobrando vale o código.

**Testes novos.** `tests/e2e/uso-real.spec.ts` (configurações com o SW parado; nenhum arquivo da extensão legível pela página e nenhum `import()` nos content scripts), `meet.spec.ts` (sem o ícone de legenda a call continua), `vigia.spec.ts` (vigia órfão; sala de grupo), `vigia-meet.spec.ts` (janela estreita; painel com gente aguardando), `interface.spec.ts` (helper que não abre; ↻ no popup; nome do perfil salvo ao sair do campo e lembrete de fixar), `modo-aba.spec.ts` (o botão do popup olha só a aba atual, que pega a mutação P1 da verificação da integração), `src/background/sessions.test.ts` (IndexedDB que falha, streaming que volta, lápide, pendentes, espera com falha, poda, destino sem permissão), `src/background/badge.test.ts`, `src/shared/helper-status.test.ts`, `src/options/form.test.ts`, `src/shared/settings.test.ts`, `src/content/vigia/contagem.test.ts`, `src/main-world/{capture/registry,platforms/meet,platforms/teams}.test.ts`, `tests/unit/gravador-host.test.ts`, `tests/unit/instalar.test.ts` e `tests/unit/publicar.test.ts`.

**Teste que dependia da sorte.** `durabilidade-downloads.spec.ts` "o helper some no meio e não volta" falhou na passada limpa desta emenda e, conferido no código de antes dela (`21ded2e`), também falha às vezes (1 em 4): o `info.json` aparece no disco um pouco antes de o SW marcar "salva", e a recuperação que o teste chama nesse intervalo deixa, de propósito, o staging de uma sessão que está finalizando. O teste agora espera o "salva" antes de devolver o helper. O produto não mudou.

**Não feito (precisa de decisão ou de medida numa call real).**
- Arbitragem só por energia (achado R1): um seam com ruído estacionário acima de -55 dBFS toma a gravação na primeira pausa e não larga. As correções óbvias (piso de ruído por seam, exigir modulação) quebram os testes com tom contínuo e precisam de uma medida no Teams com o codec WASM ligado para saber se o receptor `mainAudio` carrega ruído ou silêncio.
- Um script hostil na página pode abrir um iframe `about:blank` e pegar o canal do relay antes do hook (achado SEC-1). É a mesma classe de risco aceita na Emenda 5; fechar exige decidir se o relay deve rodar em frames `about:blank`.
- Staging de um dono que não existe mais (extensão removida e carregada de novo, achado D6) continua sem recuperação automática.
- O Meet que troca de PC e leva mais de 5 s para o novo carregar áudio ainda encerra a gravação (`call-encerrada`).
- No Meet, uma contagem que troca de fonte (selo e painel) ainda divide o mesmo pico.
- O modo aba toca na saída padrão do sistema (achado F5): ficou documentado no README.
- A marca `Symbol.for('gravador.hook')`, a mensagem `bridge:ready` na janela e o `toString` dos embrulhos continuam observáveis pela página (resíduo aceito, como na Emenda 5).

## Emenda 11: modo aba sem som em dobro (07/10/2026)

Achado na primeira call real (Teams logado em `teams.cloud.microsoft`): o áudio da call toca num `<audio>` com `setSinkId` (o dispositivo escolhido dentro do Teams). Com o modo aba ligado, esse caminho **continuou tocando**, e a extensão devolvia o som capturado à saída padrão: o usuário ouvia em dobro, com eco.

- Antes de pedir o ID da captura, o SW pergunta ao relay da frame do topo (`chrome.tabs.sendMessage`, `PAGE_OUTPUT_QUERY`, prazo de 500 ms) se algum `<audio>`/`<video>` não mudo da página tem `sinkId` não vazio (`src/content/saida.ts`, função pura). Se tiver, o modo aba começa **sem devolver** o som; senão devolve, como antes. Fora do Meet e do Teams não há relay e o som é devolvido.
- No offscreen a devolução passa por um `GainNode` (1 ou 0) entre a fonte e o `destination`, para trocar sem refazer o grafo nem a gravação. `offscreen:tab-start` ganhou `replay` e há `offscreen:tab-replay { tabId, on }`.
- O popup mostra, no item do modo aba, "Ouvindo em dobro? Desligar o som repetido" ou "Sem som da call? Ligar o som repetido" (`ui:tab-replay`). `ActiveRecording.replay` só existe no modo aba.
- Teste: unidade da regra (`saida.test.ts`), da decisão no SW (`tabcapture.test.ts`) e do ganho no offscreen (`tab.test.ts`), com as mutações "sempre devolver" pegas; o ponta a ponta do grafo agora segue fonte -> Gain -> destino.

## Emenda 12: relógio resistente e o som do modo aba de volta (07/10/2026)

**Achado na segunda call real (Teams logado, 0.1.1).** A detecção nunca viu a call: o Console mostrou uma única linha `idle emCall=false pcs=0`, e uma medição pelo próprio Console contou zero consultas da extensão em 5 s com a call conectada (estado 3). O `setInterval` criado no `document_start` rodou uma vez e morreu quando o Teams carregou; um timer criado depois, no meio da call, funcionava. Num experimento no Chrome for Testing, uma página que cancela todos os timers por força bruta mata os da extensão nos dois mundos (MAIN e ISOLATED).

- `src/shared/relogio.ts`: cada tarefa periódica tem o timer de sempre e, de reserva, um `MutationObserver` no documento (a página da call muda o DOM o tempo todo, e um callback de mutação não é cancelável). Uma tarefa atrasada além de `max(3 períodos, 3 s)` roda na hora e ganha um timer novo; `after`/`sleep` vencem pela conferência se o timer sumir. O chunk do gravador (a cada 5 s, pelo MediaRecorder) também confere.
- Usam o relógio: a verificação de 1 s e a arbitragem do `session.ts`, as esperas do fim (`finish`, `waitAccepted`), e o laço do vigia (que roda no ISOLATED e também tinha os timers mortos). O tick reenvia o `hello` se o `setTimeout` do DOMContentLoaded foi cancelado.
- `Originals.MutationObserver` capturado no `document_start`.
- Teste: unidade do relógio (`relogio.test.ts`) e o ponta a ponta "a página cancela todos os timers ao carregar e no meio da gravação" (variante `limpa-timers` do Teams). Com a conferência desligada o teste falha exatamente como na call real (nenhuma gravação começa).

**Som do modo aba (desfaz a regra da Emenda 11).** Na mesma call, com a devolução desligada pela regra do `sinkId`, o usuário ficou sem som; ligando, não houve eco. O Chrome silenciou também o que a página tocava num dispositivo próprio. A devolução volta a começar ligada; a pergunta ao relay fica só para o log, e o botão do popup continua para o caso de o eco aparecer.

## Emenda 13: transcrição automática e preparo para a loja (07/10/2026)

Pedido do usuário: transcrever sozinho ao fim de toda call, e deixar a extensão genérica para virar um repositório público e ir para a Chrome Web Store depois. Esta emenda **substitui** o que estiver em conflito acima (inclusive o "Transcrever" do README, que agora é automático). Versão 0.2.0 da extensão e do helper (`HOST_VERSION`).

**Onde mora.** Toda a transcrição fica do lado do helper, que já roda Node, já escreve a pasta e vale para todos os perfis: `host/transcricao.mjs` (configuração, motores, texto de saída, fila e trava) e `host/transcrever.mjs` (o worker). A extensão só lê o estado e repassa os pedidos das telas. Uma gravação que caiu em Downloads (sem helper) não é transcrita.

**Motores.** Um motor é `{ id, available(), transcribe(job) }`: `available()` devolve `{ ok, motivo?, detalhes }` (motivo em português, para a tela; `detalhes` com os caminhos achados), e `transcribe({ audioPath, tmpDir, timeoutMs, onSpawn })` devolve `{ segments: [{ start, end, text }], language, model }`, com tempos em segundos. A lista `ENGINES` fica aberta de propósito para um motor no navegador e outro na nuvem (`docs/LOJA.md`); hoje só existe `whisper-cpp`:
- o áudio passa antes pelo ffmpeg (`-af aresample=async=1 -ar 16000 -ac 1 -c:a pcm_s16le`), porque o whisper.cpp 1.9 só lê wav, mp3, flac e ogg-vorbis; o WAV fica num temporário em `<fila>/tmp/` e é apagado no fim;
- `whisper-cli -m <modelo> -l <idioma|auto> -t <min(4, núcleos/2)> -f <wav> -oj -of <saída> -np`, e os segmentos saem de `transcription[].offsets` (ms) do JSON, sem os vazios e sem `[BLANK_AUDIO]`;
- programas: o caminho configurado (se houver, só ele: um caminho errado é um erro a mostrar), senão o PATH, `/opt/homebrew/bin` e `/usr/local/bin` (o Chrome abre o helper sem o PATH do terminal); o mesmo para o ffmpeg;
- modelo: o configurado, senão o melhor achado em `~/.cache/whisper-models`, `~/.whisper-models`, `~/.cache/whisper.cpp`, as pastas do whisper-cpp do Homebrew, `<pasta do config.json>/modelos` e `~/Library/Application Support/gravador-de-calls/modelos`, na ordem large-v3-turbo > large-v3 > medium > small > base (o cheio antes do quantizado; os `.en` só com idioma `en`). Nada é baixado.

**Fila durável e worker destacado.**
- O `finalize` que termina com `info.json` (inclusive o órfão e o merge do modo aba) chama `queueTranscription`: com `transcricao.ativa`, grava `<pasta do config.json>/fila/<ms>-<8 hex>.json` (`{ versao, id, pasta, audio, criadoEm, estado, tentativas }`), marca `transcricao.status: pendente` no `info.json` e abre o worker se nenhum estiver rodando. Falhar aqui nunca falha o finalize (vai para o log). O finalize repetido de uma sessão já terminada (lápide) não enfileira de novo.
- Sem duplicar: a mesma pasta e o mesmo áudio já na fila, ou com o `info.json` em `pendente`, `transcrevendo` ou `pronta`, ficam como estão. O áudio é `audio.webm`, ou o primeiro `audio*.webm` numa pasta só do modo aba.
- O helper abre `node transcrever.mjs` com `detached: true` e `unref()`: grupo de processos próprio, então ele continua quando o Chrome fecha o helper. A saída vai para o mesmo log do helper quando o stderr dele é um arquivo (o wrapper manda para `~/Library/Logs/gravador-de-calls/helper.log`); senão, para lugar nenhum (nos testes de unidade o stderr do helper é um pipe, que prenderia o teste).
- **Trava** `fila/worker.lock` com `{ pid, inicio }`, criada com `open(..., 'wx')`. Com o pid morto a trava é velha, sai e a tentativa se repete; um arquivo sem pid e com menos de 5 s é de um worker que acabou de criar e conta como viva. Só o dono solta. O helper só abre um worker sem trava viva, mas quem decide é a trava: um worker que não a pega sai na hora.
- Um trabalho por vez: o worker pega o mais antigo, marca `transcrevendo` (no trabalho e no `info.json`) e grava no trabalho o pid e o nome de cada filho (ffmpeg, whisper) antes de seguir. Com a fila vazia ele solta a trava e confere a fila de novo (um trabalho que entrou nesse meio é pego por ele ou pelo worker que o helper abrir).
- O helper, ao abrir (o Chrome o abre no primeiro ping de cada perfil), confere a fila e abre o worker se sobrou trabalho (o Mac desligou no meio da transcrição), sem esperar a próxima call terminar.
- **Retomada.** Ao subir com um trabalho em `transcrevendo` (o worker anterior morreu com kill -9, queda, desligamento), o worker novo mata o filho que sobrou se o pid ainda for daquele programa (`ps -o command=` contém o nome gravado) e refaz o trabalho. Assim nunca há dois whisper ao mesmo tempo. Interrompido três vezes, vira `falhou`.
- Prioridade baixa: `os.setPriority(10)` no worker, herdada pelos filhos. Limite de tempo por processo de `max(20 min, 2 x duração da call)`, só para um processo travado não segurar a fila para sempre.

**Saída na pasta da call** (escritas num temporário com `fsync` e `rename`, então só aparecem completas):
- `transcricao.md`: título, depois plataforma, data e hora locais (tiradas do ISO com fuso do `info.json`, sem depender do fuso de quem transcreve), duração, participantes, perfil (se houver) e motor, modelo e idioma; a fala em parágrafos `[mm:ss] texto`, ou `[h:mm:ss]` em todos quando a call tem uma hora ou mais. Parágrafo: segmentos seguidos com pausa de até 2 s, quebrando depois de 300 caracteres no fim de uma frase e sempre depois de 700. Sem fala: "_Nenhuma fala reconhecida na gravação._".
- `transcricao.srt`: um bloco por segmento original do whisper.
- `info.json.transcricao` (lido, mudado e escrito atômico a cada estado): `{ status: 'pendente' | 'transcrevendo' | 'pronta' | 'falhou', motor, modelo, idioma, audio, inicio, fim, duracaoProcessamentoSeg, arquivos, erro? }`. Na falha, `erro` em português (`modelo não encontrado: <caminho>`, `whisper-cli não encontrado em <caminho> (confira o caminho nas configurações)`, `o whisper-cli falhou (código N): <linha do erro>`, `o ffmpeg não conseguiu converter o áudio`, `áudio não encontrado`) e o áudio fica. O tipo `InfoTranscription` é do contrato; a extensão nunca escreve esse campo.
- O `finalize` com merge (modo aba entrando na pasta da página) mantém o `transcricao` do `info.json` que já estava lá. Uma pasta apagada antes da vez dela sai da fila sem erro.

**Configuração** (`config.json` do helper, ao lado de `root`, vale para todos os perfis): `transcricao: { ativa: true, motor: 'whisper-cpp', modelo: '', idioma: 'auto', whisperCli: '', ffmpeg: '' }`. Campo inválido volta ao padrão na leitura; `readConfig` devolve o arquivo inteiro e `set-root` não perde mais os outros campos.

**Operações novas do helper** (e `HostReq` em `protocol.ts`):
- `get-config` passa a devolver também `transcricao` e `motores: [{ id, rotulo }]`;
- `set-transcription { patch }`: só campos conhecidos; `ativa` booleano; `motor` da lista; `idioma` `auto` ou 2 a 3 letras minúsculas; caminhos absolutos ou com `~`, e o modelo tem de existir e os programas de ser executáveis; grava e devolve `{ transcricao }`;
- `transcription-status { paths? }`: `{ ativa, motor, idioma, disponivel, motivo, detalhes, modeloEncontrado, trabalhando, fila, recentes: [{ path, transcricao }] }`; cada caminho pedido só é lido se, pelo caminho real, estiver dentro da raiz atual ou de uma raiz gravada nos índices das sessões (senão `transcricao: null`);
- `open-file { path }`: abre com o aplicativo padrão (`open` no macOS, `xdg-open` no Linux; `GRAVADOR_OPEN_CMD` só nos testes) e só um arquivo `transcricao*.md` ou `.srt`, pelo caminho real (sem `..` nem symlink para fora) dentro das mesmas raízes: um caminho que viesse do popup não abre um aplicativo nem um arquivo qualquer;
- `choose-file { prompt }`: o seletor de arquivo do macOS (o modelo).
`open-file` e `choose-file` entram nas operações fora da fila serial, com `choose-folder` e `reveal`.

**Extensão.**
- `src/background/transcription.ts`: `transcriptionForPopup(recent, helper)` pergunta `transcription-status` com os caminhos das até 10 últimas gravações salvas pelo helper, no máximo a cada 2 s (o popup pede o estado a cada 1 s), e devolve `UiState.transcription: TranscriptionUiState | null` (null sem helper) com o estado por `sessionId`. Um helper de antes da 0.2.0 responde "operação desconhecida", e isso vira "o helper instalado é de uma versão sem transcrição: rode npm run instalar de novo". `ui:set-transcription` passa pelo `transcriptionPatchSchema` (zod, `strict`) antes do helper; `ui:open-transcript { sessionId }` monta o caminho a partir da gravação salva, nunca de quem pede; `ui:transcription` e `ui:choose-model` servem as configurações.
- Popup: em cada uma das últimas gravações, "Na fila para transcrever.", "Transcrevendo...", "Transcrição pronta." com "Abrir transcrição", ou "Transcrição falhou: motivo"; uma salva em Downloads diz "Sem transcrição: ela precisa do helper local." (menos quando o helper diz que a transcrição está desligada). Regra pura `transcriptionOf` em `src/popup/format.ts`.
- Configurações, seção "Transcrição": formulário próprio com react-hook-form (o resolver zod de `form.ts` virou `zodFormResolver`, usado pelos dois formulários), salvo no helper por "Salvar transcrição"; motor, modelo com "Escolher modelo...", idioma, caminhos dos programas em "Avançado" e a linha de disponibilidade com o motivo. Sem helper, diz que a transcrição precisa dele. O nome do perfil segue salvando ao sair do campo e o resto do perfil no "Salvar" de sempre.

**Preparo para a loja (sem enviar nada).**
- A chave do manifesto só entra no build de desenvolvimento: `manifest.config.ts` tira o `key` com `GRAVADOR_LOJA=1`. `npm run empacotar` (`scripts/empacotar.mjs`) faz esse build em `artifacts/loja/extensao` (o `dist/` não é tocado), recusa um manifesto que ainda tenha `key`, e grava `artifacts/gravador-de-calls-<versão>.zip` sem os mapas de fonte (zip feito em Node, sem dependência). `artifacts/` está no `.gitignore`. O `npm run build`, o `npm run publicar` e os testes continuam com a chave, então o ID da extensão instalada sem compactação nunca muda. Conferido uma vez: o pacote carrega no Chrome for Testing, com outro ID, e o popup abre dizendo que o helper não está instalado (o ID da loja ainda não está em `allowed_origins`).
- `npm run instalar -- --id <id>` (repetido ou separado por vírgula) acrescenta IDs em `allowed_origins`, junto com o de desenvolvimento, para uma cópia da loja usar o mesmo helper. A instalação copia agora `gravador-host.mjs`, `transcricao.mjs` e `transcrever.mjs` (`HOST_FILES`), e a desinstalação tira os três; a fila (`fila/`) fica, como `config.json` e `sessoes/`.
- Exemplos e dados de teste genéricos: nome de perfil "Trabalho", participantes fictícios, sem nomes de empresa nem de pessoa no código, nos testes e nestes documentos fora de `docs/pesquisa` e `docs/referencia` (que ficam como estão, por serem registro da pesquisa).
- Fica de propósito: o nome do host de native messaging (`com.enkode.gravador_calls`). Trocar exige reinstalar o helper junto com a extensão nova, senão a extensão publicada para de achar o helper no meio do uso; vale decidir junto com o nome de quem publica na loja (`docs/LOJA.md`).
- `docs/LOJA.md` lista o que ainda falta para a loja.

**Testes novos** (cada um conferido falhando com a mutação indicada no código e voltando a passar):
- `tests/unit/transcricao.test.ts`: segmentos do JSON do whisper (sem vazios e sem `[BLANK_AUDIO]`), junção em parágrafos (nunca juntar, sem limite duro), `[h:mm:ss]` de call longa, transcrição vazia, SRT, descoberta de programas (PATH ignorado, configurado caindo no PATH) e de modelos (preferência invertida, `.en` em português), e a validação da configuração.
- `tests/unit/transcricao-fila.test.ts`, com ffmpeg e whisper-cli falsos (`tests/helpers/fake-transcricao.ts`): ciclo de vida, falha que mantém o áudio (falha que apaga o áudio, falha que diz pronta), motivos de modelo e whisper ausentes, um por vez com dois workers e três trabalhos (trava não exclusiva), retomada depois de kill -9 matando o whisper órfão (sem matar o órfão), trava velha e trava viva, e a fila que não duplica (sem a conferência da fila).
- `tests/unit/gravador-host.test.ts`, bloco da transcrição: `get-config` e `set-transcription` (set-root que grava só a raiz), o finalize abrindo o worker de verdade até `pronta` (sem abrir o worker), o helper que retoma a fila ao abrir (sem a retomada), merge que mantém a transcrição, desligada sem nada, motivo da indisponibilidade uma pasta fora da raiz que o `transcription-status` não lê (sem conferir a raiz) e `open-file` (sem conferir a raiz, sem conferir o nome, sem caminho real com um symlink para fora).
- `tests/unit/instalar.test.ts` (os três arquivos copiados e o helper copiado abrindo; IDs a mais), `tests/unit/empacotar.test.ts` (chave, mapas de fonte, CRC do zip), `src/background/transcription.test.ts` (cache, helper antigo, zod, só as gravações do helper), `src/popup/format.test.ts` e `src/options/form.test.ts`.
- `tests/e2e/transcricao.spec.ts`: call do Meet gravada e salva com o helper apontando para os programas falsos produz `transcricao.md` (cabeçalho e o texto falso) e `.srt`, `info.json.transcricao.status: pronta`, e o popup mostra "Abrir transcrição", que abre o arquivo (sem o estado no popup, sem o clique); a falha aparece no popup com o motivo; desligada não produz nada nem fila (helper ignorando `ativa`); configurações com a disponibilidade e salvando no helper (SW sem repassar); o botão do modelo se chama "Escolher modelo..." e os testes antigos das configurações pegam o "Salvar" do perfil pelo nome exato, porque a página passou a ter dois formulários; sem helper, o aviso no popup e nas configurações (popup sem o aviso).
- O harness grava `transcricao: { ativa: false }` no `config.json` de todo teste que não pede outra coisa (`LaunchOptions.transcricao`): a padrão do produto é ligada e descobriria o whisper e o modelo de verdade da máquina.
- Teste real, fora do `npm test`: `npm run teste:transcricao-real` gera fala com o `say` do macOS, converte para WebM/Opus como uma gravação, e roda o worker de verdade com o whisper-cli e o modelo desta máquina numa pasta e num `config.json` temporários.

**Não feito.**
- Motor no navegador e motor na nuvem (só a interface).
- Refazer uma transcrição que falhou pelo popup (hoje: corrigir a configuração e gravar de novo, ou rodar o worker à mão).
- Uma escrita do worker no `info.json` ao mesmo tempo que um `finalize` com merge na mesma pasta pode perder a mudança de um dos dois (os dois leem, mudam e trocam o arquivo inteiro). É o modo aba terminando no mesmo segundo em que a transcrição da página muda de estado; o próximo estado do worker reescreve a transcrição.
- Separar falantes, resumo e tradução.

O contrato que nenhuma parte muda sozinha passa a incluir `TranscriptionConfig`, `InfoTranscription`, `InfoJson.transcricao`, as quatro operações novas do helper, `UiState.transcription`, as quatro `UiReq` novas e `LaunchOptions.transcricao`.

### Emenda 13, revisão depois da verificação 1 (07/10/2026)

Substitui o que estiver em conflito acima, nesta emenda.

**Modo aba na pasta da página (era o defeito maior).** O modo aba é o plano B de quando a gravação da página não pega áudio, e o `audio-aba.webm` que entrava por merge nunca era transcrito: a fila só pegava `audio.webm` (o silencioso) e a conferência de duplicado recusava a pasta. Agora a transcrição é por áudio:
- `listAudios(pasta)`: `audio.webm` primeiro, depois os outros `audio*.webm`; `enqueueTranscription` põe na fila cada um que ainda não está pronto nem na fila (devolve `{ queued, ids, motivo }`).
- Saída por áudio (`transcriptStem`): `audio.webm` escreve `transcricao.md` e `.srt`; `audio-aba.webm` escreve `transcricao-aba.md` e `.srt` (o `open-file` já aceitava `transcricao*.md`). O `.md` de um áudio que não é o `audio.webm` diz de qual é (`- **Áudio:** audio-aba.webm (modo aba)`).
- `info.json.transcricoes: { [áudio]: InfoTranscription }` guarda o estado de cada um, e `info.json.transcricao` continua sendo o do áudio principal: o último posto na fila (o do modo aba, quando ele entra depois). Uma pasta de antes (só `transcricao`) é lida como `transcricoes[transcricao.audio]`. O finalize com merge mantém `transcricao` e `transcricoes` de quem já estava lá.
- O popup abre o `.md` que o `info.json` da principal diz em `arquivos` (`ui:open-transcript` pergunta o `transcription-status` daquela pasta; um nome fora de `transcricao*.md` vira `transcricao.md`), e o helper confere a raiz e o nome de novo.

**Sem o motor, a call espera em vez de falhar.** Sem whisper-cli, ffmpeg ou modelo, a transcrição não vira mais `falhou`: o trabalho fica na fila e o `info.json` diz `status: pendente` com `espera: <motivo>`. `startQueue(configDir, cfg, spawnWorker)` (helper, depois do finalize, ao abrir e depois de `set-transcription`) só abre o worker se a transcrição estiver ligada, houver trabalho, nenhum worker vivo e o motor estiver disponível; senão marca os trabalhos como esperando. O worker que acha o motor indisponível marca todos e sai. Assim, corrigir o caminho nas configurações (ou instalar o whisper e o Chrome abrir o helper de novo) transcreve as calls que esperavam, sem gravar de novo. `falhou` fica para o que deu errado transcrevendo (o whisper saiu com erro, o ffmpeg não converteu, o áudio sumiu, o limite de tempo, três interrupções). Um `falhou` entra de novo na fila no próximo finalize daquela pasta (o merge do modo aba). `erro` e `espera` só valem no estado em que foram escritos: somem na mudança seguinte que não os traz.

**Desligar com o worker rodando.** O worker confere `ativa` antes de cada trabalho: desligada, ele para e deixa o resto na fila (pendente), que volta quando ligar de novo (o `set-transcription` com `ativa: true` abre o worker).

**Trava.**
- Trava velha trocada sob a trava de troca `fila/worker.lock.troca` (criada com `wx`): só quem segura a troca apaga a trava do worker, e confere de novo antes. Uma trava que existe não pode ser substituída sem a troca (o `wx` falha), então a conferida é a que sai, e a nova é criada ainda segurando a troca. Antes, três workers disputando a mesma trava velha ficavam com dois donos em 2 de 60 rodadas; o teste agora faz 80 rodadas com quatro processos de verdade e exige um dono só (conferido: sem a troca, falha em toda execução). Uma troca de um processo que morreu no meio dela sai depois de 10 s.
- Pid reaproveitado (reboot): a trava só é viva se o processo do pid começou antes dela (`ps -o etime=`, com 3 s de folga); senão é velha. Sem `ps`, vale o pid vivo.

**Processos.** O ffmpeg e o whisper abrem grupo de processos próprio (`detached`): o limite de tempo mata o grupo (o filho e o que ele abriu) e devolve quando o filho sai, sem esperar um neto que segure a saída. A sobra de um worker morto também é morta pelo grupo, depois da conferência do nome do comando. O limite mínimo é `MIN_TIMEOUT_MS` (20 min; `runWorker` aceita `minTimeoutMs` nos testes).

**Erros de disco.** `writeAtomic` apaga o temporário quando a escrita falha. O erro inesperado de um trabalho (pasta sem permissão, disco cheio) só tira o trabalho da fila depois de o `info.json` dizer `falhou`; se nem isso deu, o trabalho fica com `errosInesperados` e é pulado nesta rodada (sem laço), e sai de vez na terceira. `enqueueTranscription` marca `pendente` antes de gravar o trabalho, para um worker que pegue e falhe na hora não ser desfeito. O `transcription-status` mostra `falhou` ("a transcrição saiu da fila sem terminar") para um `pendente` ou `transcrevendo` sem trabalho na fila há mais de 10 s (`reconcileTranscription`), e um pendente assim entra de novo na fila.

**Texto.**
- `speechText`: o whisper.cpp escreve o silêncio de uma call como `[Música]` em português. Saem as marcas entre colchetes (`[BLANK_AUDIO]`, `[Música]`, `[Aplausos]`), `♪`, e um segmento que é só `(música)`, `(risos)` ou `*música*`; um segmento sem letra nem número também sai. Uma gravação só de silêncio dá "_Nenhuma fala reconhecida na gravação._".
- Parágrafos pela pausa medida: o whisper.cpp põe o silêncio dentro do segmento anterior (os segmentos saem colados, e os tempos por token também são esticados por cima do silêncio, medido com `-ojf` e `-ml 1` em 07/10/2026), então a regra dos 2 s quase nunca valia. O ffmpeg da conversão roda também `silencedetect=noise=-40dB:d=2` (stderr em nível info, até 4 MB guardados) e `silencesFromFfmpeg` lê as pausas; uma pausa de 2 s ou mais quebra o parágrafo na fronteira logo depois do segmento em que ela termina perto do fim (até 1 s antes) e antes do começo do seguinte. Medido com a fala do `say` e 4 s de silêncio no meio: dois parágrafos, `[00:00]` e `[00:08]`. Um `silence_start` sem `silence_end` vale até o fim do áudio.
- `dropInventedSegments`: o whisper inventa frase em cima de silêncio (uma gravação muda de 10 s, com idioma `auto` e o small, deu "you"). Sai do `.md` e do `.srt` o segmento curto (até 6 palavras) com o meio dentro de um silêncio medido e menos de 0,3 s fora dele; sem pausas medidas, nada sai. Uma frase longa nunca cai, então uma call gravada baixinho (abaixo de -40 dB) perde no máximo frases curtas. O log do worker conta quantos saíram.

**Configuração.**
- `applyTranscriptionPatch` só confere o caminho que mudou: a tela manda a configuração inteira, e um modelo que sumiu da pasta impedia de salvar qualquer coisa, inclusive desligar.
- Modelos: `large-v3-turbo > large-v3 > large-v2 > large-v1 > large > medium > small > base > tiny`. O motivo de "modelo não encontrado" diz as famílias aceitas.

**Popup.** Rodapé com `transcriptionNotice` (`src/popup/format.ts`): "Sem transcrição: <motivo>." com um helper de antes da 0.2.0, e "Transcrição indisponível: <motivo>. As calls ficam na fila até isso ser resolvido." com a transcrição ligada sem o motor. Sem helper, nada (as gravações em Downloads já dizem). Uma gravação esperando o motor mostra "Na fila, esperando: <motivo>".

**Testes novos ou mais fortes** (cada um conferido falhando com a mutação e voltando a passar):
- `transcricao-fila.test.ts`: espera sem o motor e entra quando o motor aparece (motor ausente virando falha; `startQueue` abrindo sem motor), erro velho que some (sem tirar `erro`), áudio que sumiu (sem conferir o áudio), três interrupções (sem o limite), limite de tempo com o whisper e o `sleep` dele mortos (limite 0), trabalho que entra antes de a trava sair (sem reconferir a fila), desligar com o worker rodando (sem conferir `ativa`), erro inesperado sem laço e desistindo na terceira (sem pular, sem desistir), modo aba transcrito como principal com `transcricao-aba.md` e o da página intacto, pasta só do modo aba, pid reaproveitado do whisper (sem conferir o comando), trava de pid reaproveitado (sem conferir o início do processo), trava velha disputada (sem a trava de troca), escrita atômica sem temporário (sem apagar), pausas do ffmpeg falso chegando ao `.md` e gravação muda sem fala (worker sem as pausas, sem tirar as inventadas). A retomada depois do kill -9 espera o pid do whisper gravado no trabalho e o log do whisper falso, não só o log (era instável).
- `gravador-host.test.ts`: merge do modo aba transcrito pelo helper de verdade (só o primeiro áudio, merge que apaga `transcricoes`, aba que não vira principal, saída sempre `transcricao.md`), ao abrir desligada não retoma e ligar retoma (retomar ignorando `ativa`), finalize sem whisper que espera e `set-transcription` que transcreve (sem abrir o worker), worker que continua com o grupo do helper morto (sem `detached`), pendente perdido mostrado como falhou (sem reconciliar), pasta irmã `<raiz> outra` (sem `path.sep`). Os testes da retomada usam um `config.json` próprio, porque um worker do bloco ainda vivo pegaria o trabalho (é a reconferência da fila funcionando).
- `transcricao.test.ts`: marcas do whisper, pausas do ffmpeg, segmento inventado no silêncio (frase longa que cairia junto), nome por áudio, `[h:mm:ss]` pelo fim da fala sem a duração, linha do áudio, caminho que sumiu, todas as famílias de modelo e o tiny sozinho.
- `src/background/transcription.test.ts` (o `.md` da principal, nome fora do padrão, `espera`) e `src/popup/format.test.ts` (o aviso do rodapé).
- `tests/e2e/transcricao.spec.ts`: a falha agora vem do whisper falso saindo com erro; sem o whisper-cli a call espera, o popup diz por quê, e corrigir o caminho em "Avançado" transcreve; um helper 0.1.0 de verdade (o atual embrulhado, recusando as operações novas) faz o popup e as configurações dizerem para reinstalar.
- `tests/helpers/fake-transcricao.ts`: arquivo `eco` faz o whisper falso escrever o conteúdo do áudio, para o teste saber qual foi transcrito, e `silencios.txt` vira o stderr do silencedetect no ffmpeg falso.

**Ainda não feito.** Um botão "Transcrever de novo" no popup; motor no navegador e na nuvem; a corrida entre o worker e um finalize com merge na mesma pasta (os dois reescrevem o `info.json`; o estado seguinte do worker corrige).

## Emenda 14: volume por aba no popup (07/10/2026, 0.2.1)

Pedido do usuário: um controle de volume por aba, no estilo do Volume Master, dentro do popup desta extensão (AC21). Esta emenda **acrescenta** ao "Modo aba" e às Emendas 11 e 12; nada nelas muda de comportamento com o volume em 100%.

**Mecanismo.** `chrome.tabCapture` da aba (abrir o popup é a invocação da extensão que libera a captura; nos testes, `--allowlisted-extension-id`), consumida no offscreen como `fonte -> GainNode -> destino`. Em 100% sem modo aba, a captura é desfeita e a aba volta ao caminho de som dela (e ao dispositivo de saída que ela escolheu com `setSinkId`). Fora de 100%, o som sai pela saída padrão, como no modo aba (achado F5 da Emenda 10); o popup avisa.

**Um ganho só.** O GainNode da devolução (Emenda 11) virou o ganho de saída da captura: `ganho = replay ? volume : 0` (`audibleGain` em `src/shared/volume.ts`). Sem gravação, `replay` é sempre ligado. O botão "som repetido" do modo aba continua valendo e combina com o volume.

**Dois modos no offscreen (`src/offscreen/tab.ts`).** `TabAudio` (stream, AudioContext, fonte, ganho, volume, replay) é a captura da aba; `Capture` é a gravação do modo aba, pendurada nela (`audio.rec`). O Chrome só deixa uma captura por aba, então:
- `volume`: só fonte -> ganho -> destino, sem gravador (`offscreen:tab-volume-start`).
- `gravando`: o modo aba. `offscreen:tab-start` sem `streamId` reaproveita a captura de volume (nenhum segundo `getUserMedia`; o volume continua); com `streamId`, abre uma captura nova a 100%.
- Parar a gravação com o volume fora de 100%, a devolução ligada e a faixa viva tira o gravador e o medidor da fonte e mantém a captura só de volume; em 100%, a captura é desfeita como antes. Com a devolução desligada (o usuário desligou o "som repetido" porque a página toca num dispositivo próprio, Emenda 11), a captura também é desfeita: religar a devolução ao parar traria o som em dobro de volta, sem nenhum controle no popup para desligar (o botão só existe durante o modo aba).
- `offscreen:tab-volume` muda o ganho nos dois modos; `offscreen:tab-volume-stop` desfaz só a captura de volume e, gravando, apenas volta o ganho a 1 (100% nunca para uma gravação); `offscreen:tab-audio` responde `{ mode, volume, replay, gain }`.
- A faixa que termina (aba fechada, ou o Chrome encerrando a captura) fecha a gravação, como antes, e desfaz a captura. **A navegação não termina a faixa:** medido no Chrome for Testing 151 (verificação da fatia), a captura e o ganho continuam depois de navegar no mesmo site, para outro site e para `chrome://version/`. Decisão: o volume é da aba, como no Volume Master, e vai junto na navegação.
- Limitador: `fonte -> GainNode -> DynamicsCompressorNode -> destino`. Até 100% o limitador fica neutro (`ratio` 1, curva identidade, sem ganho de compensação); acima de 100%, `threshold` -1 dBFS, `ratio` 20, sem joelho, ataque de 3 ms: o pico amplificado não estoura na saída. Só a saída passa por ele; o gravador continua na fonte.

**As gravações não passam pelo volume.** O gravador e o medidor do modo aba ligam na fonte, antes do ganho. A gravação automática na página (MAIN world) não vê a captura de aba: os ganchos tiram o som dentro da página, não da saída.

**SW (`src/background/tabvolume.ts`).** `ui:tab-volume-get { tabId }` responde `{ volume, active, mode }`; `ui:tab-volume-set { tabId, volume }` limita a 0..2 (`clampVolume`, também no offscreen) e decide com `decideVolume(mode, volume)`: sem captura, 100% não faz nada e outro valor abre a captura de volume; só de volume, 100% a desfaz e outro valor ajusta; gravando, sempre só ajusta. Os dois pedidos são validados com zod (`parseTabVolumeReq`). A verdade da captura fica no offscreen: o SW pergunta (`offscreen:tab-audio`) quando o `getCapturedTabs` diz que a aba está capturada e guarda o volume por aba enquanto ela vive; aba fechada (`tabs.onRemoved`), `tabCapture.onStatusChanged` parado e captura que sumiu fazem o SW esquecer. Offscreen sem resposta com a aba capturada: com um volume lembrado, o SW trata a captura como só de volume (o 100% tenta desfazê-la, em vez de pedir ao Chrome uma segunda captura, que ele recusa); sem nada lembrado, segue sem modo. Volume e toggle do modo aba passam pela mesma fila por aba (`withTabLock`), para nunca pedir duas capturas da mesma aba ao mesmo tempo.

**Toggle do modo aba (`tabcapture.ts`).** Uma aba capturada sem sessão do modo aba era lida como captura órfã e o toggle a parava. Agora, se o offscreen diz `volume`, é um início em cima dela (sem `getMediaStreamId`); se a captura sumiu entre a decisão e o início, o SW pede um ID novo e grava. Sem o volume, continua como antes.

**Popup.** Seção "Volume desta aba" (`TabVolume` em `Popup.tsx`) para a aba atual com URL http ou https (`volumeEligibleUrl`) e também para qualquer aba que o `ui:tab-volume-get` diga estar capturada (`active`), mesmo em `chrome://`, PDF ou URL que o popup não vê: a captura sobrevive à navegação e o usuário precisa de um jeito de voltar a 100% dali (com uma linha que explica). Sem captura, essas páginas ficam sem a seção. Controle de 0 a 200% de 5 em 5, o valor, o botão "100%" e o aviso da saída padrão. O movimento vai ao SW 120 ms depois do último; soltar o controle (`pointerup`), soltar a tecla (`keyup`), o "100%" e o popup fechando (`pagehide`) mandam o valor pendente na hora, para o último movimento nunca se perder. Ao abrir, o popup lê o volume que vale (`ui:tab-volume-get`).

**Gancho de teste.** `tabAudioState(tabId)` (só leitura, em `tabcapture.ts`): o que o offscreen responde ao `offscreen:tab-audio`, para o teste ler o ganho que se ouve sem saída de áudio.

**Testes.** Unidade: `src/shared/volume.test.ts` (limite, decisão, ganho, URL), `src/offscreen/tab.test.ts` (só volume, o modo aba em cima dela sem segundo `getUserMedia` e com o gravador ligado à fonte, volta a só volume, 100% que para a captura de volume e não a gravação, devolução desligada dá 0, faixa que termina), `src/background/tabvolume.test.ts` (decisões, limite, captura que o Chrome encerrou, SW reiniciado, dois pedidos ao mesmo tempo) e `src/background/tabcapture.test.ts` (toggle em cima da captura de volume, captura que sumiu, órfã continua parar). Ponta a ponta, `tests/e2e/volume.spec.ts`: 150% pelo popup dá ganho 1,5 sem gravar e 100% desfaz a captura; com 30%, o `audio-aba.webm` fica no nível de uma gravação a 100% (diferença medida 0,00 dB) e a captura continua só de volume a 30%; numa call do Meet com a gravação na página, 30% deixa o `audio.webm` com o 440 Hz a -6,0 dBFS antes e depois (fatia 1: -6,0) e sem o microfone; o popup reaberto mostra 150% e uma página `chrome://` sem captura não tem o controle. Cada teste novo foi conferido vermelho com uma mutação (gravador depois do ganho: -10,5 dB; parar desfaz sempre; ganho sem volume; 100% sem desfazer; 100% que para a gravação; toggle sem olhar o volume; popup sem ler o volume; controle em toda aba; gravação da página atenuada).

**Depois da verificação da fatia (rodada 1).** A verificação mostrou que a captura sobrevive à navegação (o texto anterior dizia o contrário) e achou caminhos sem teste. Acrescentado: o volume continua depois de navegar no mesmo site, para `outro-site.test` e para `chrome://version/`, e o popup aberto ali mostra o controle e volta a 100% (`volume.spec.ts`, "o volume é da aba"); o último movimento do controle chega ao SW com a tecla solta e com o popup fechando antes da espera (`volume.spec.ts`, com o relógio do popup parado por `page.clock`, então só o envio na hora leva o valor); devolução desligada ao parar desfaz a captura; a faixa que termina com o volume fora de 100% durante a gravação desfaz a captura; um modo aba logo depois da faixa terminar não reaproveita a captura que acabou; a captura reaproveitada segue o `replay` pedido; o gravador que falha numa captura reaproveitada deixa só o volume; o `tab-volume-start` também limita a 0..2; o limitador neutro até 100% e ligado acima (`tab.test.ts`); offscreen sem resposta, `tabs.onRemoved` e `onStatusChanged` (`tabvolume.test.ts`); volume e toggle ao mesmo tempo nas duas ordens, uma captura só (`tabcapture.test.ts`); `parseTabVolumeReq` recusa `tabId` -1 e 1,5 (`volume.test.ts`). Cada um conferido vermelho com a mutação correspondente.

**Não feito.** Na página fora dos hosts das calls, o popup só vê a URL pelo `activeTab` do clique no ícone; o teste abre o popup como página e usa `meet.google.com/__tom` (página que não é call). O controle numa aba de outro site fica para a verificação manual, junto com ouvir o volume de verdade e o limitador acima de 100% (os testes sobem com `--disable-audio-output`; o teste de unidade só confere o grafo e os parâmetros).


## Emenda 15: pronta para a Chrome Web Store (07/10/2026, 0.3.0)

Pedido do usuário: preparar a primeira versão da loja. Decisões dele (07/10/2026): quem instala pela loja **não tem o helper**, então a versão da loja tem de ser completa sem ele; português e inglês já nesta versão; política de privacidade num site estático no Vercel (feito em paralelo, fora desta fatia), com o contato e a marca de quem publica (Enkode). Esta emenda **acrescenta**; nada muda com o helper instalado, a não ser o idioma dos textos.

**Tradução (`chrome.i18n`).**
- Mensagens em `public/_locales/en/messages.json` (padrão: `default_locale: "en"`) e `public/_locales/pt_BR/messages.json`; o crxjs copia `public/` para o pacote. O manifesto usa `__MSG_extName__`, `__MSG_extDescription__`, `__MSG_actionTitle__` e `__MSG_commandTabMode__`. O nome é o mesmo nas duas línguas (Gravador de Calls, a marca).
- `src/shared/i18n.ts`: `t(chave, ...valores)` sobre `chrome.i18n.getMessage`, com a chave tipada pelo `en/messages.json` (uma chave que não existe não compila); `$1`..`$9` direto na mensagem (medido no Chrome for Testing 151: o Chrome troca os posicionais sem `placeholders`, e um valor que falta vira vazio). `tp(base, n)` escolhe `<base>_one` ou `<base>_other` pela regra do idioma da mensagem que o Chrome escolheu (`Intl.PluralRules` com a mensagem `localeTag`: em português 0 e 1 são singular, em inglês só 1). Fora da extensão (sem `chrome.i18n`), `t` devolve a chave.
- Passam por `t()`: popup, configurações, boas-vindas, notificações, títulos do badge, `helper-status.ts`, `format.ts` (durações, data pelo `date-fns` no locale da mensagem, áudio, linha do vigia, avisos da transcrição), mensagens do formulário (`form.ts`: as do zod e as próprias do schema, trocadas pelo campo), os erros do SW que as telas mostram (`reveal.ts`, `tabcapture.ts`, `tabvolume.ts`, `transcription.ts`, `ui-api.ts`), os títulos dos seletores do macOS e o indicador do vigia na página. `<html lang>` e o título de cada página seguem o idioma.
- **Pasta em Downloads pelo idioma**: `sink-downloads.ts` decide a cada salvamento (`downloadsFolder()`): `Gravações de calls` em português, `Call recordings` em inglês. O formato do `info.json` (as chaves) não muda: é contrato. No nome da pasta da call, as palavras seguem o idioma (`naming.ts`: `Sem título`/`Untitled`, `(Outro site)`/`(Other site)`); `(Meet)` e `(Teams)` são nomes próprios, e `Gravação recuperada` (staging órfão, só com o helper) fica em português.
- **Dados em português, tradução na ponta**: a fonte da contagem do vigia viaja no protocolo e no log como o texto de `contagem.ts` (constantes em `src/shared/vigia-source.ts`), e o indicador na página e o popup mostram `vigiaSourceLabel(fonte)`. O offscreen não tem `chrome.i18n` (só `chrome.runtime`): os motivos dele continuam em português e o SW os traduz com `offscreenReason` (`src/shared/offscreen-reasons.ts`) antes de mandar à tela ou ao registro. Os erros do próprio SW (`sink-host.ts`, `sink-downloads.ts`, `sessions.ts`, `tabcapture.ts`) passam por `t()` na origem.
- **Motivos do helper** (`friendlyFsError` e os da transcrição, em português): o helper não muda nesta versão (não vai pela loja e quem o tem pode estar numa versão anterior), então `src/shared/helper-reasons.ts` reconhece cada motivo conhecido pelo texto e o troca por uma chave estável (`hr*`), passando inteiros os valores variáveis (caminho, código do Node, programa, código de saída, a linha de erro do programa). Um motivo desconhecido aparece como veio. Mandar o idioma ao helper ficou de fora (não foi preciso). Os nomes dos arquivos da transcrição não mudam (recurso só do helper).
- Testes: `tests/helpers/i18n-setup.ts` (setup do vitest) monta um `chrome.i18n` falso com as mensagens de verdade, em português por padrão (`useLocale('en')` troca), e o injeta também em todo `globalThis.chrome = {...}` dos testes antigos.

**Boas-vindas e aviso da primeira execução.**
- `src/welcome` (entrada do Vite, como o offscreen): o que é gravado (só o áudio dos outros, nunca o microfone, a gravação começa sozinha), onde fica (`Downloads/<pasta>`, nada sai do computador, sem servidor), o consentimento (pode ser exigido de todos, conforme o país e o estado: LGPD no Brasil, todas as partes em alguns estados dos EUA) e o link da política de privacidade (`privacyUrl`, por idioma). "Entendi" grava `chrome.storage.local.consent = { version: 1, at, via: 'pagina' }` (por perfil; `src/shared/consent.ts`). A página escreve direto no storage (o SW reage pelo `storage.onChanged`).
- `src/background/welcome.ts`: no `runtime.onInstalled`, `install` sem confirmação abre a página; `update` sem confirmação **vindo de uma versão anterior à 0.3.0** (`details.previousVersion`, comparado por número) grava `via: 'atualizacao'`: quem usava antes da 0.3.0 nunca viu o aviso e grava calls de verdade todo dia, e parar a gravação automática dele no meio do expediente seria pior que o aviso (a página continua a um clique nas configurações). Qualquer outra atualização sem confirmação (da 0.3.0 em diante, ou sem `previousVersion`) não faz nada: quem instalou já com o aviso e fechou a página sem "Entendi" continua sem gravação automática quando o Chrome atualiza a extensão sozinho (o badge e o popup continuam pedindo). Subir `CONSENT_VERSION` pede a confirmação de novo.
- **Sem a confirmação, a gravação automática não começa**: `autoAllowed(plataforma, settings, consent)` (pura) vale no `settings` que o SW manda no `hello` e no `broadcastSettings` (que agora lê a configuração e a confirmação sozinho), e no relay, que ouve `settings` **e** `consent` no `storage.onChanged` (o SW pode estar dormindo). Assim, confirmar com a call aberta faz o MAIN world sair de `idle` para `candidate` e gravar, sem recarregar a aba. O `onStart` do SW também recusa (`session:rejected`, motivo novo `no-consent` em `RejectReason`) um `session:start` que chegue antes do `settings`. O modo aba (atalho ou botão) não é bloqueado: é um pedido explícito.
- Popup: "A gravação automática ainda não começou..." com "Ler o aviso" (abre a página) enquanto `UiState.consentGiven` for falso. Badge global: `!` azul com o título "leia e confirme o aviso..."; as gravações não salvas (Emenda 10) continuam com prioridade (`globalBadge(pendentes, semAviso)` em `badge.ts`, pura). As configurações têm os links do aviso e da política de privacidade.

**Sem o helper como uso normal.**
- `helperProblem` diz "Salvando em Downloads/<pasta>." para `nao-instalado`, e o popup mostra em cinza (antes, âmbar com "Helper não instalado"). As configurações mostram "Salvando em Downloads/<pasta>." e, numa seção "Avançado: helper local", a escolha da pasta, a transcrição e o helper (com o `npm run instalar` para quem usa o código-fonte), cada um com "exige o helper local, ainda não distribuído pela loja"; a seção "Transcrição" e o seletor de pasta somem. Nenhum texto em vermelho ou âmbar sem o helper.
- `transcriptionOf`: uma gravação em Downloads só diz "Sem transcrição: ela precisa do helper local." quando o helper existe e a transcrição está ligada (a gravação caiu em Downloads porque o helper falhou); sem helper nenhum, nada.
- O helper instalado (mesmo que não abra) deixa as telas como antes: `nao-abre` e `sem-permissao` continuam avisos, porque são problemas de quem instalou.

**Pacote da loja.**
- `GRAVADOR_LOJA=1` (o `npm run empacotar` já usava) passa a valer também no código: `vite.config.ts` define `__STORE_BUILD__` (declarado em `src/build-flags.d.ts`; `vitest.config.ts` o define como `false`). Com ele, `index.ts` não cria `globalThis.__gravador` e `registerTestHooks` não registra nada: o minificador apaga o bloco e os ganchos somem do pacote (conferido por nome). O manifesto do pacote sai sem `key` e com `homepage_url: https://gravador-de-calls.vercel.app` (`SITE_URL` em `manifest.config.ts`; se o site mudar de endereço, é aqui e em `privacyUrl`). O resto do manifesto é igual ao de desenvolvimento.
- Permissões revisadas: nenhuma saiu; a justificativa de cada uma está em `docs/LOJA.md`. Sem código remoto: nenhum script de fora, `import()` de URL, `importScripts`, `eval` ou `Function()`. O zod vem de `src/shared/zod.ts`, com `jitless` ligado antes de qualquer schema: o teste interno dele com `Function()` (`allowsEval`) fica no pacote mas nunca roda. `PAGE_OUTPUT_QUERY` mora em `constants.ts`, e o relay (content script de toda frame das calls) não carrega o zod.
- Configurações sem o helper no pacote da loja: a seção "Avançado" não mostra o `npm run instalar` (quem instala pela loja não tem a pasta do projeto); o build de desenvolvimento continua mostrando.

**Testes.**
- Ponta a ponta no idioma: no macOS o Chrome ignora `--lang` (medido: com `--lang=pt-BR`, `chrome.i18n` continua no idioma do sistema). O harness abre o Chrome for Testing por um wrapper gerado em `test-results/gravador/chrome-<idioma>.sh` que passa `-AppleLanguages (<idioma>)` (preferência do processo para o macOS) e tira o `about:blank` do Playwright (o headless recusa duas páginas iniciais; o par vira a página inicial `http://(pt-br)/`, que o harness troca por `about:blank`). `--lang` vai junto, para Linux e Windows. `LaunchOptions.locale` (padrão `pt-BR`, para os testes antigos, que conferem textos em português) e `LaunchOptions.consent` (padrão: o harness espera a página de boas-vindas da instalação, clica "Entendi" e a fecha; `false` deixa sem confirmar). O `chrome.i18n.getUILanguage()` do SW não serve para conferir o idioma (sai do `navigator`, que o Playwright emula em en-US); o teste lê a mensagem `localeTag`.
- `tests/e2e/idioma-e-aviso.spec.ts`: em inglês, a instalação abre as boas-vindas em inglês; até "I understand" uma call do Meet não grava (badge `!` e o aviso do popup, cujo botão abre a página); confirmado, a call já aberta começa a gravar. Em inglês sem helper, popup e configurações em inglês e a gravação em `Downloads/Call recordings` (sem `Gravações de calls`). Em português, as boas-vindas e o manifesto (descrição do atalho, título do ícone) traduzidos. `tests/e2e/pacote-loja.spec.ts`: o build da loja numa pasta temporária, carregado no Chrome for Testing, sem `__gravador` no SW, com `homepage_url`, boas-vindas na instalação e o popup sem helper. `interface.spec.ts` e `transcricao.spec.ts`: os testes sem helper passam a conferir o modo sem alerta e a seção "Avançado".
- Unidade: `src/shared/i18n.test.ts` (as mesmas chaves e os mesmos `$n` nas duas línguas, toda chave usada no código existe, nenhuma sobra, sem travessão, descrição até 132 caracteres, `t`, `tp` e o plural de cada idioma), `src/shared/consent.test.ts` (`autoAllowed`, versão do aviso, `consentActionFor`), `src/shared/helper-reasons.test.ts` (cada motivo do helper, com `friendlyFsError` de verdade, sai igual em português e traduzido em inglês, com os valores inteiros), `badge.test.ts` (`globalBadge`), `sessions.test.ts` (sem o aviso, `hello` com as duas plataformas desligadas e `session:start` recusado com `no-consent`), `format.test.ts` (sem helper, nada na gravação), `tests/unit/pacote-loja.test.ts` (os dois builds em pastas temporárias: sem `key`, `homepage_url`, sem `__gravador` nem nomes de ganchos, o resto do manifesto igual, `__MSG_` e as duas línguas, sem código remoto, as permissões da tabela do `docs/LOJA.md`). Depois da verificação: `src/content/relay.test.ts` (o relay de verdade, com janela e chrome falsos: mudar a configuração sem o aviso confirmado manda ao MAIN as duas plataformas desligadas), `consent.test.ts` também com `onInstalledConsent` (atualização da 0.3.0 sem o aviso não confirma; da 0.2.1 confirma), `vigia-source.test.ts` (fontes e indicador sem literal), `offscreen-reasons.test.ts` (todo motivo literal do offscreen, lido do código, traduzido), `zod.test.ts` (`jitless`), `naming.test.ts` em inglês e o pacote da loja sem `Function()` fora do teste do zod, sem zod no relay e (ponta a ponta) sem `npm run` nas configurações.

**Não feito.**
- Os rótulos do `transcricao.md` continuam em português (recurso só do helper).
- O erro cru do `chrome.downloads` (`d.error`, um código como `FILE_FAILED`) e as exceções do navegador aparecem como vieram (já em inglês).
- O "lembrete para avisar os participantes" durante a call ficou para depois (`docs/LOJA.md`).
- A verificação numa call real continua com o usuário; nesta fatia nada foi enviado à loja.

O contrato que nenhuma parte muda sozinha passa a incluir `CONSENT_KEY` e o formato de `ConsentRecord`, `RejectReason` `no-consent`, `UiState.consentGiven`, as chaves das mensagens usadas por mais de uma parte (`downloadsFolderName`, `privacyUrl`, `localeTag`) e `__STORE_BUILD__`.

## Emenda 16: quando sair da call, escrito por extenso (08/10/2026, 0.3.1)

Pedido do usuário (07/10/2026), depois de mandar a 0.3.0 para a loja: as opções de sair da call estavam confusas (os seis números do script em "Avançado"); ele quer escolher em palavras, como "sair quando tiver metade das pessoas" ou "menos que uma quantidade específica". Esta emenda muda **a escolha** e o texto; o laço do vigia, a contagem, a saída e o fechamento depois de salvar (Emendas 2, 3, 4 e 10) não mudam.

**Modo na configuração (`VigiaCfg`, `src/shared/protocol.ts`).**
- `modo: 'sozinho' | 'proporcao' | 'quantidade'` (`VIGIA_MODOS` em `constants.ts`) e `quantidade` (inteiro de 1 a 50), além dos seis números do script, que continuam.
- O limite de cada modo mora em `src/shared/vigia-rule.ts` (`limiteDoPico`, puro, sem zod), usado pela régua (`regua.ts` o reexporta), pelo popup e pelas configurações:
  - `proporcao`: o do script, `pico >= picoParaQueda ? max(minimo, floor(pico * fracao)) : 1`. É o padrão e é o modo de toda configuração guardada sem `modo`.
  - `quantidade`: `pico > quantidade ? quantidade : 1`. Uma call que nunca passou de N não sai "com N ou menos" no pico; até lá, só sai sozinho.
  - `sozinho`: sempre 1.
- A régua (`criarRegua`) é a mesma: `armado = pico >= 2`, ficar com 1 sai na hora, e as confirmações valem para as outras saídas (com limite 1, só o 0 do script conta, como antes). No modo `proporcao` ela continua igual ao `criarRegua` do script leitura a leitura (o teste de 3000 sequências segue valendo), e o modo `sozinho` é igual ao script com `picoParaQueda` infinito (teste de 500 sequências).
- **Migração:** `normalizeSettings` mescla com `DEFAULT_VIGIA` (`modo: 'proporcao'`, `quantidade: 2` e os números do script, em `SCRIPT_VIGIA`), então quem tinha a configuração antes da 0.3.1 fica em `proporcao` com os números dele, e nada muda no comportamento. Modo desconhecido ou quantidade inválida voltam ao padrão sem derrubar os outros campos. O schema continua recusando a combinação que sairia de uma call cheia (Emenda 10).

**Configurações (`LeaveRule` em `src/options/Options.tsx`).**
- A chave "Sair e fechar a aba quando a call esvaziar" (desligada por padrão); com ela desligada, a regra continua visível e editável, esmaecida.
- "Quando sair", três escolhas (rádios com nome acessível próprio): "Quando eu ficar sozinho na call"; "Quando sair boa parte das pessoas: restar [fração] ou menos do maior número de pessoas que a call teve" (três quartos, metade, 30% (o padrão) e um quarto, mais a fração guardada quando for outra: `opcoesDeFracao`); "Quando restarem [N] pessoas ou menos, contando você". Mexer no seletor da fração ou no número marca a escolha correspondente.
- "Confirmar antes de sair": na hora, 10 s, 20 s, 30 s. O formulário guarda `confirmacoes` (o valor de negócio); as opções saem de `opcoesDeConfirmacao(intervaloSeg, atual)` (`confirmacoesPara(s, intervalo) = max(1, round(s / intervalo))`, "na hora" é 1 leitura) e mostram os segundos de verdade (`confirmacoes x intervaloSeg`), incluindo o valor atual quando ele não é um dos quatro. Escondido no modo sozinho, em que não se aplica.
- O exemplo (`vigiaExample` em `src/shared/vigia-text.ts`) é calculado com `limiteDoPico` sobre uma call de 10 pessoas (ou maior, se o modo só vale acima disso: `picoDoExemplo`), por exemplo: "Exemplo: numa call que chegou a 10 pessoas, o vigia sai quando restarem 5 ou menos, depois de 20 s confirmando. Se você ficar sozinho, sai na hora. Numa call que nunca passou de 3 pessoas, só sai quando você ficar sozinho." Com números inválidos, pede a correção.
- "Ajustes finos" (fechado): intervalo, leituras para considerar que a call acabou, pico mínimo e mínimo de pessoas da proporção, cada um com rótulo e explicação em palavras simples, e "Voltar aos valores padrão". Mudar o mínimo revalida o pico (`deps`), para a mensagem da combinação sumir quando o usuário corrige o outro campo.
- Mensagens: a quantidade tem uma frase só ("escolha de 1 a 50 pessoas"); a da combinação fala com os rótulos novos. Tudo pelas mensagens `chrome.i18n` nas duas línguas; as chaves `vigiaFieldFraction` e `vigiaFieldConfirmations` saíram.

**Popup e indicador.** A mesma linha nos dois (`vigiaCountLine`), no lugar do formato do script (`5 na call | pico 8 | sai com <= 2`): "6 na call · pico 10 · sai com 5 ou menos", "· sai se você ficar sozinho" com limite 1 (modo sozinho, ou call ainda pequena para o modo), "(espera alguém entrar)" no lugar de "(desarmado)" e "· confirmando 2/4" no lugar de "| queda 2/4". O indicador acrescenta "· via <fonte>". O log do vigia diz o modo ao começar.

**Testes.** Unidade: `regua.test.ts` (tabela dos três modos com call que nunca chegou ao limite, sozinho, leituras null, confirmações, quantidade 1 e 50, troca de modo com a call aberta, configuração antiga migrada igual ao script, sozinho igual ao script sem a queda), `vigia-rule.test.ts` (segundos e leituras, frações oferecidas, pico do exemplo), `vigia-text.test.ts` (linha e exemplo em português e inglês), `settings.test.ts` (migração e modo ou quantidade inválidos), `form.test.ts` (os três modos, a quantidade fora de 1 a 50 e as mensagens), `format.test.ts`. Ponta a ponta: `tests/e2e/vigia-opcoes.spec.ts`, em português (cada escolha muda o exemplo, mensagem da quantidade, guarda "sozinho" com uma leitura por segundo, o vigia de uma call de 10 fica com 2, e trocar para "3 ou menos, na hora" com a call aberta sai na leitura seguinte) e em inglês (as escolhas e o exemplo em inglês, os segundos que acompanham o intervalo, a mensagem da combinação que some ao corrigir, e o vigia sai com metade da call); `vigia.spec.ts` ganhou um teste por modo novo (quantidade 3: call que nunca passou de 3 fica com 2, na de 10 fica com 4 e sai com 3 depois de 2 leituras; metade: na de 10 fica com 6 e sai com 5 depois de 4 leituras). O observador do indicador (`tests/fixtures/vigia/indicador.ts`) reconhece também o prefixo em inglês. Cada teste novo foi conferido vermelho com uma mutação (quantidade com `>=`, modo sozinho ignorado, migração para outro modo, linha sem o caso de limite 1, mensagem da quantidade, segundos de confirmação errados, fração atual fora da lista, exemplo sem a frase da call pequena, seletor da fração sem marcar a escolha, exemplo fixo, sem `deps`, fração fixa em 30%).

**Não feito.** A verificação numa call de verdade continua com o usuário. A 0.3.0 está em análise na loja: a 0.3.1 vai depois, por ele.

## Emenda 17: proxy do Defender for Cloud Apps, captura presa e versões diferentes (08/10/2026, 0.3.1)

Três problemas de uso real achados pelo usuário em 08/10/2026, no Chrome 154 dele. Esta emenda **acrescenta**; nada muda nos hosts de antes nem com o SW e as páginas na mesma versão. Sai junto com a fatia do vigia (outra branch) como 0.3.1.

### A. Teams pelo proxy do Defender for Cloud Apps

**Achado.** A empresa do usuário abre o Teams pelo Conditional Access App Control do Microsoft Defender for Cloud Apps, um proxy de sessão que acrescenta um sufixo ao host do app: a call fica em `https://teams.cloud.microsoft.mcas.ms/`. O manifesto só casava `teams.cloud.microsoft`, então nenhum content script entrava e a gravação automática nunca começava. O sufixo comercial é `.mcas.ms` (os regionais `.cas.ms` foram unificados nele em 2020); os tenants de governo usam `.mcas-gov.us` e `.mcas-gov.ms`.

- **Fonte única** `src/shared/hosts.ts` (sem dependências, nem de tipo: o MAIN world e o `manifest.config.ts` importam, e o carregador de configuração do Vite não resolve import sem extensão; por isso o tipo `Platform` nasce nele e o `protocol.ts` o reexporta): `PLATFORM_HOSTS` (Meet: `meet.google.com`; Teams: `teams.microsoft.com`, `teams.cloud.microsoft`, `teams.live.com`), `PROXY_SUFFIXES`, `hostsOf(plataforma)` (os simples e, para cada um, os três sufixos), `CALL_HOSTS` (16 hosts), `CALL_MATCHES` (`https://<host>/*`) e `platformOfHost` (sem diferenciar maiúsculas, com o ponto final aceito; `evil.mcas.ms` ou `teams.cloud.microsoft.mcas.ms.evil.com` não passam).
- `manifest.config.ts` gera daqui os `matches` dos três content scripts e os `host_permissions`. Leem daqui: `pickAdapter` (`install.ts`, agora exportado), `meetCode` (o gate do Meet) e o `matchesUrl` do Teams, `platformOfUrl` (`tabcapture.ts` e o do popup), `isCallHostUrl`/`isCallTabUrl` (badge e AC16), a plataforma do vigia (`vigia.ts`, só a detecção), e as rotas das páginas falsas dos testes (`tests/fixtures/routes.ts` e `teams/routes.ts`) e o `isCallHost` do harness. O relay não decide por host.
- Pelo proxy a página é a mesma do Teams (ou do Meet): o adaptador é o mesmo, com o título, o código e o ID lidos da URL do mesmo jeito (as expressões olham o caminho, não o host).
- **Loja.** Os 16 hosts entram nas listagens (`docs/loja/listagem-*.md`, com a explicação do proxy), na política de privacidade (`site/privacidade.html` e `site/en/privacy.html`, data 08/10/2026; site publicado de novo no Vercel) e na tabela de permissões do `docs/LOJA.md`. **Permissão de host nova é revisão nova**: o pacote da 0.3.1 tem de substituir a 0.3.0 em revisão (passo a passo em `docs/loja/ENVIAR.md`); numa extensão publicada, o Chrome desligaria a cópia instalada até o usuário aceitar a permissão.
- Testes: `src/shared/hosts.test.ts` (a lista, o manifesto gerado dela, cada host pelo proxy no adaptador, no gate, no código e nos IDs, no badge; mutações conferidas: `pickAdapter` só com os simples, `matchesUrl` sem o proxy, badge sem o proxy), `tabcapture.test.ts` (`platformOfUrl`), `tests/unit/pacote-loja.test.ts` (os 16 `host_permissions` na ordem, nas listagens e nas políticas) e `tests/e2e/teams.spec.ts` ("pelo proxy do Defender for Cloud Apps": a call do Teams falso em `teams.cloud.microsoft.mcas.ms` grava sozinha, badge REC, e salva com título, código, ID e participantes como no host simples; com o manifesto sem o proxy, nenhuma gravação começa).

### B. Captura da aba presa por outra extensão

**Achado.** O popup mostrou "Tab mode: tab capture denied: Cannot capture a tab with an active stream." porque o Volume Master estava capturando a aba: o Chrome só deixa uma captura por aba, e o Volume Master não a solta.

- `src/background/capture-id.ts`: `tabStreamId(tabId)` pede o `getMediaStreamId` (usado pelo modo aba em `tabcapture.ts` e pelo volume em `tabvolume.ts`) e devolve o erro já traduzido por `captureErrorMessage`: o texto do Chrome com "Cannot capture a tab with an active stream" vira `errCaptureBusy` ("Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba. Desligue essa extensão em chrome://extensions, ou feche e reabra a aba, e tente de novo." e o equivalente em inglês); qualquer outro erro continua `errCaptureDenied` com o texto do Chrome. O popup mostra como "Modo aba: ..." e "Não deu para mudar o volume: ...", até a próxima ação.
- A mesma frase aparece se a captura presa for uma nossa que se perdeu (o Chrome não diz de quem é): fechar e reabrir a aba resolve os dois casos.
- Gancho de teste `failTabStreamId(mensagem)`: o próximo pedido falha com aquela mensagem, sem chegar ao Chrome.
- Testes: `capture-id.test.ts` (a mensagem nas duas línguas, outro erro intacto, o gancho de um pedido só), `tabvolume.test.ts` (o Chrome falso recusando como o Volume Master) e `tests/e2e/captura-ocupada.spec.ts` (o popup em português e em inglês, no modo aba e no volume; sem o mapeamento, o teste vê exatamente o texto do achado).

### C. SW de uma versão, páginas de outra

**Achado.** Num perfil, o service worker ainda era o código da 0.1.2 (o nome do bundle provou) e o popup era o da 0.3.0: o Chrome guarda o script do SW de uma extensão sem compactação até ela ser recarregada, mas lê as páginas do disco a cada abertura. O popup mandou `ui:tab-volume-set`, o SW antigo não conhecia, a resposta veio `undefined`, e o popup quebrou em silêncio ("Cannot read properties of undefined (reading 'ok')"): o controle de volume não fazia nada.

**1. Versão embutida.** `scripts/build-info.mjs` calcula `{ version, build }`: a versão do `package.json` e um hash curto das **entradas** do build (`src/` sem os testes, `public/`, o manifesto, as configurações do Vite, o `package-lock.json`, a chave), não da saída, que contém o próprio identificador. O mesmo código dá sempre o mesmo `build` (republicar o mesmo build continua permitido pelo `publicar`), e o pacote da loja tem outro. O `vite.config.ts` define `__APP_VERSION__` e `__BUILD_ID__` (declarados em `src/build-flags.d.ts`; no vitest, a versão e `vitest`) e grava `dist/versao.json`. `src/shared/version.ts` exporta `BAKED`. O `ui:state` devolve `worker: BAKED` (ausente num SW de antes da 0.3.1) e o offscreen responde `offscreen:version` (ele é lido do disco quando o SW o abre, então um SW antigo pode abrir um offscreen novo). O `offscreen:version` é só para diagnóstico e para o `versao.spec.ts`: o SW não pergunta nem compara, o aviso vem do `ui:state` nas telas. Não houve `ui:ping`: o `ui:state` já é a primeira leitura das duas telas.

**2. Aviso.** `versionSkew(page, worker, manifesto, update)` (pura) compara o bundle da tela com o SW, com o manifesto que o Chrome carregou e com a publicação que o SW viu (item 4). Diferente: `VersionBanner` (`src/shared/VersionBanner.tsx`, no popup e nas configurações) mostra "Este perfil ainda está com a versão X da extensão rodando. Recarregue a extensão para usar a versão Y." (sem a versão do SW: "uma versão anterior"; com a mesma versão e outro build, a versão com o build), o que segura a recarga sozinha, e **Recarregar agora** (`chrome.runtime.reload()`), desligado com o porquê enquanto houver gravação. As configurações usam a leitura única que já faziam ao abrir. Decisão sem precedente no projeto: o componente compartilhado mora em `src/shared`, porque o popup e as configurações não importam um do outro.

**3. Resposta vazia vira erro.** `uiCall` rejeita com `UiNoAnswerError` ("o service worker da extensão não respondeu ao pedido \"ui:...\" (ele pode estar rodando uma versão anterior: recarregue a extensão)") quando a resposta é `undefined` ou `null`; cada tela já mostrava a rejeição como as outras falhas, e o volume lido ao abrir e o "Mostrar no Finder" passaram a mostrar também. `useUnhandledUiErrors` é a rede de segurança do popup e das configurações: uma rejeição que nenhuma seção tratou (o vigia, que esta fatia não muda) aparece como "Algo falhou: ...". Ganchos de teste: `fakeWorkerVersion` (outra versão, ou `'omitir'`) e `dropUiRequests` (o SW não responde a esses pedidos, como o antigo).

**4. Recarga sozinha** (`src/background/auto-reload.ts`). O `npm run publicar` já gravava `publicado.json` (versão e impressão digital) na pasta publicada; agora grava também o `build` do `dist/versao.json`. O SW confere ao subir e num alarme de 1 minuto (`gravador:versao-publicada`, criado só quando o arquivo existe) com `fetch(chrome.runtime.getURL('publicado.json'), { cache: 'no-store' })`. Sem o arquivo (o pacote da loja, onde `__STORE_BUILD__` também desliga tudo, e o `dist/`), nada. `decideAutoReload` (pura): publicação com a versão ou o build diferentes dos embutidos e nada em uso, `recarregar`; com algo em uso, `esperar` e o motivo (`gravando`: sessão aberta na memória ou no IndexedDB; `salvando`: finalizando ou interrompida por salvar; `call-aberta`: qualquer aba nos hosts das calls; `volume`: aba capturada por esta extensão, porque recarregar desfaria o volume dela; `iniciando-captura`: a fila de captura por aba do `tabvolume.ts` com algo dentro, isto é, um modo aba ou um volume pedido agora pelo atalho ou pelo popup, antes de a sessão existir e de o `getCapturedTabs` mostrar a captura, lido por último antes de decidir; `configuracoes-abertas`: a página de configurações aberta, por `chrome.runtime.getContexts`, porque recarregar a fecha e perde o que não foi salvo); a mesma publicação já tentada, `desistir`. Antes de recarregar, o SW grava `recargaAutomatica = { key: versão+build, at, from, to }` em `chrome.storage.local`: um `publicado.json` que não bate com o código do disco (editado à mão, publicação pela metade) recarregaria o mesmo código para sempre, então a mesma publicação é tentada uma vez só, e o aviso diz para conferir a pasta. Esperando, o badge global mostra **↑** roxo com o título da versão (depois das não salvas e do aviso da primeira execução, `globalBadge`) e o popup mostra o aviso com o motivo. Escolha declarada: "diferente" e não "mais nova", porque a pasta publicada é a verdade (voltar uma publicação também recarrega).

**Medido no Chrome for Testing 151 (08/10/2026):** `chrome.runtime.reload()` numa extensão sem compactação com o **Modo do desenvolvedor desligado** deixa a extensão desligada (`unsupportedDeveloperExtension`); ligado, ela volta com o SW novo. Os perfis de verdade que carregam a pasta publicada têm o modo ligado (é o que libera o "Carregar sem compactação"); quem o desligar depois perde a extensão na próxima recarga, sozinha ou à mão. O harness ganhou `LaunchOptions.developerMode` (liga pela página `chrome://extensions`) e `LaunchOptions.extensionDir` (carrega uma cópia publicada numa pasta temporária).

**5. `npm run publicar`** diz, depois de publicar, que os perfis recarregam sozinhos em até 1 minuto quando nada estiver em uso, o que aparece até lá (↑ e o aviso com "Recarregar agora"), que um perfil ainda de antes da 0.3.1 precisa recarregar uma vez à mão (pelo botão do popup) e como recarregar agora (`publishedMessage`).

**Testes** (cada um conferido vermelho com a mutação e verde de volta): `src/shared/version.test.ts` (a regra do aviso: tudo igual, SW sem o campo com e sem o manifesto diferente, outra versão, mesmo build, publicação esperando; textos nas duas línguas), `src/shared/ui-client.test.ts` (undefined e null rejeitam, nas duas línguas; sem a conferência, falha), `src/background/auto-reload.test.ts` (cada motivo de espera, a captura pedida com a fila de verdade do `tabvolume.ts` segurando e soltando, as configurações abertas e as outras páginas da extensão que não seguram, sem publicação, em dia, publicação sem `build`, desistir e o SW novo que desiste, sessão só no IndexedDB, o alarme; sem a conferência da tentativa, de cada motivo e do build, falha), `badge.test.ts` (o ↑ e a prioridade), `tests/unit/publicar.test.ts` (`build` no `publicado.json`, e a mensagem), `tabcapture.test.ts` (a captura presa por outra extensão no modo aba, nas duas línguas, sem sessão criada), `tests/e2e/proxy.spec.ts` (o vigia e o popup no Teams falso em `teams.cloud.microsoft.mcas.ms`: o vigia conta, o popup mostra a contagem e a plataforma, e ficar sozinho sai e fecha a aba; sem a detecção do proxy no vigia ou no popup, falha), `tests/unit/pacote-loja.test.ts` (o pacote da loja nem lê o `publicado.json`, os dois builds com o `versao.json` e o build embutido, e os ganchos novos fora do pacote) e `tests/e2e/versao.spec.ts`: o SW e o offscreen dizem o `dist/versao.json` e o popup fica sem aviso; com o SW "0.1.2" (gancho), o aviso no popup e nas configurações, "uma versão anterior" sem o campo, o botão desligado durante uma gravação do Meet e ligado depois, e o clique recarrega a extensão de verdade (SW novo, sem aviso, a gravação salva); em inglês, o aviso e o erro do pedido sem resposta; sem resposta ao `ui:tab-volume-set` e ao `ui:tab-volume-get`, o erro no popup e nenhuma exceção solta, e uma rejeição sem dono aparece; numa cópia publicada pelo `publish()` numa pasta temporária com o `publicado.json` reescrito para 9.9.9, recarrega uma vez, o SW novo desiste (badge ↑, aviso com "já foi tentada"), e nenhuma recarga a mais; e durante uma gravação espera (`gravando`, `call-aberta`, badge e título, aviso com o motivo, botão desligado), continua esperando com a aba do Meet aberta depois da call, e recarrega quando as abas fecham, com a gravação salva. Mutações conferidas no ponta a ponta: sem a tentativa gravada (laço), sem os motivos de espera, `uiCall` sem a conferência, popup sem o aviso.

**Não feito.**
- A forma do proxy com hífens no lugar dos pontos (`teams-cloud-microsoft.mcas.ms`), se o Defender for Cloud Apps a usar em algum tenant: não confirmada, então não entrou. O host do achado é o com pontos.
- Verificar numa call real pelo proxy de verdade (ele reescreve os scripts da página) e a recarga sozinha num perfil de verdade: ficam com o usuário (ESPEC, "Em aberto").
- **Decisão declarada, para o usuário confirmar:** qualquer aba do Meet ou do Teams aberta segura a recarga sozinha, mesmo fora de uma call. Quem deixa o Teams web aberto o dia todo não recarrega sozinho: vê o ↑ e o aviso e usa "Recarregar agora". Segurar só nas abas com call em andamento é possível (o AC16 já marca as abas de call depois de uma recarga), mas recarregar com o Teams aberto deixa o content script dele órfão até a aba recarregar, e a próxima call nessa aba não gravaria sozinha.
- Uma captura pedida no instante entre a gravação da tentativa no `chrome.storage.local` e o `chrome.runtime.reload()` (uma escrita local) ainda se perde; a janela antes disso está coberta pelo `iniciando-captura`.
- A extensão não sabe se o Modo do desenvolvedor está ligado (a API é privada do Chrome): a recarga sozinha confia que está, como está em quem carregou a pasta sem compactação.

O contrato que nenhuma parte muda sozinha passa a incluir `src/shared/hosts.ts` (a lista e `platformOfHost`), `BuildInfo`, `UiState.worker` e `UiState.update` (`AutoReloadState`), `offscreen:version`, o `build` do `publicado.json`, `dist/versao.json`, `__APP_VERSION__` e `__BUILD_ID__`, e as chaves `errCaptureBusy` e `errWorkerNoAnswer`.

## Emenda 18: quem disse o quê (09/10/2026, 0.4.0)

Pedido do usuário (08/10/2026): na transcrição, dizer quem falou cada trecho entre os participantes da call. Esta emenda **acrescenta**; sem nenhum sinal de falante, a gravação, o `info.json` e a transcrição saem exatamente como antes. A pesquisa dos sinais está em `docs/pesquisa/falantes-2026-10-09.md`.

**A validação numa call real (Meet e Teams de verdade, com várias pessoas falando) está pendente e só o usuário pode fazer.** Os testes automáticos provam a mecânica com páginas que imitam os sinais; os formatos de rede (protobuf do Meet, `dsh` do Teams) são engenharia reversa de terceiros e não foram vistos neste projeto numa call de verdade.

### Na página (MAIN world)

**Contrato do adaptador** (`src/main-world/platforms/types.ts`), três ganchos opcionais:
- `installSpeakerSignals(ctx)`: chamado uma vez na instalação (`install.ts`, no `document_start`), liga a escuta passiva dos sinais. Falhar aqui não impede a gravação.
- `readSpeakers(probe): { nomes, fonte } | null`: quem fala agora entre os participantes remotos. Lista vazia é ninguém; `null` é "não tenho como dizer agora". `probe` (`SpeakerProbe`) tem `now` (época), `contributingSources()` (os CSRCs dos receptores de áudio vivos, lidos pelo registry, sem expor os PCs) e `remoteSpeech` (o seam selecionado, medido ao vivo na arbitragem, tem fala agora; ausente quando não se sabe). Um nome ainda desconhecido vai como chave provisória (`SPEAKER_KEY_PREFIX` + tipo + id).
- `speakerAliases()`: o nome de cada chave provisória que já dá para resolver (a roster pode chegar depois do CSRC, lição do Meeting-BaaS #330).

**Linha do tempo** (`src/main-world/speakers/timeline.ts`, pura). O controlador da sessão lê o adaptador e o microfone no laço de 250 ms da arbitragem, no relógio resistente (Emenda 12). Abre o intervalo na primeira leitura em que a pessoa aparece e fecha depois de `CLOSE_AFTER_MS` (1 s) sem ela: é essa histerese que mantém no mesmo intervalo quem para menos de 1 s entre frases. (A primeira versão tinha também uma junção de quem voltava até 0,5 s depois do fim; com o fim em `última leitura + 250 ms` e o fechamento só depois de 1 s sem a pessoa, ela nunca disparava, e saiu.) Um intervalo aberto há `MAX_OPEN_MS` (30 s), um sinal preso ou um monólogo, é cortado em dois pedaços que se encostam, e o SW os junta de novo (`mergeIntervals`): sem o corte, cada lote reenviaria tudo desde o começo dele (medido numa simulação de 2 h com uma pessoa sempre "falando": lote médio de 66 KB e máximo de 133 KB a cada 5 s). `null` vale como ninguém (fecha depois da histerese). Limite de `MAX_SPEAKER_INTERVALS` (20000) por gravação.

**Envio.** `{ t: 'session:speakers', sessionId, from, intervals, aliases? }` (zod no SW, `UP_TYPES` no relay): a cada 5 s, junto do diagnóstico, só os intervalos que ainda podem mudar (a partir do primeiro aberto; um fechado não muda mais); e no fim, antes do `session:end`, a linha inteira a partir do 0 (um lote perdido num SW que reiniciou é refeito ali, e o que aconteceu depois do último lote de 5 s vai junto). O `pagehide` também manda a linha inteira, antes do `session:end`: ali o gravador para na hora, sem gravar o atraso do mixer, então a linha é cortada no fim do áudio (`closeAll(agora, agora - startedAt)`): quem começou ao vivo no último 1,5 s sai, e nada passa do fim.

**Alinhamento com o áudio gravado.** O áudio sai `MIXER_DELAY_MS` (1500 ms, a linha de atraso do mixer, agora em `src/shared/constants.ts`) depois do sinal ao vivo. Cada leitura no instante `agora` vale, no áudio, em `agora - startedAt + MIXER_DELAY_MS` (`toRecordingMs`); o `falantes.json` diz `atrasoMs: 1500`. O fim fecha a linha no começo do `finish`, antes da espera do atraso: o que viesse depois cairia depois do fim do áudio. Os tempos não descontam lacunas de chunks (raras; o áudio fica mais curto que a linha).

**Sinais do Meet** (`platforms/meet-speakers.ts`), em ordem, sem clicar nada, sem abrir painel, sem ligar legenda:
1. CSRC (`speakers/csrc.ts`): ativo é o CSRC cujo `timestamp` ou `rtpTimestamp` mudou desde a leitura anterior (na primeira, carimbo de até 1 s; carimbo no relógio do `performance.now()` convertido pelo `timeOrigin`), com `audioLevel >= 0.01` quando houver. Vale enquanto houve alguma entrada nos últimos 12 s. `String(csrc)` é o `streamId` de um `deviceOutput` da roster, que leva ao `deviceId` e ao nome.
2. `dcrpc` (snapshot gzip com a flag de fala por device): vale por 30 s depois de chegar (cadência não documentada). É o caminho NetEq, em que o CSRC vem vazio.
3. Medidor do DOM (`[jsname="QgSmzd"]` com a classe trocando em até 800 ms, dentro de `[data-participant-id]`, sem o seu bloco nem o de apresentação): só com a aba visível.
Roster (`speakers/meet-signals.ts`, `MeetRoster`): canal `collections` (zlib ou gzip, `DecompressionStream` nativo) e a resposta do fetch `SyncMeetingSpaceCollections` (base64), com o protobuf lido sem esquema em qualquer profundidade (`speakers/protobuf.ts`). Reserva do nome: o `span.notranslate` do bloco cujo `data-participant-id` é o `deviceId`. Fica só o space do próprio usuário (`isCurrentUserString` ou o bloco com `[data-self-name]`); o próprio device e as apresentações nunca viram falante.

**Sinais do Teams** (`platforms/teams-speakers.ts`), em ordem:
1. CSRC, com o nome por `participant.hasAudioSource(csrc)` no objeto da call (sem o lobby, `state === 7`) e reserva nos `endpoints.endpointDetails[].mediaStreams[]` (`type: 'audio'`, `sourceId`). A fonte do `localSignalingParticipant` nunca vira falante. CSRC sem dono vira chave provisória (só existe no áudio dos outros).
2. `dsh` do canal `main-channel` (o JSON depois dos bytes de cabeçalho, tentando a partir de cada `[` ou `{`): o dominante até o próximo. Um `dsh` que não bate com nenhum participante vale como ninguém (o dominante pode ser você). O `dsh` só avisa quando o dominante muda, nunca quando a fala acaba: o dominante só conta enquanto `probe.remoteSpeech` não for `false` (no silêncio da call, ninguém fala; sem a medida, vale o dominante), e deixa de valer quando todos os `main-channel` escutados fecham (listener de `close`; aí volta o indicador do DOM).
3. Indicador do bloco de vídeo (`[data-tid="voice-level-stream-outline"][data-is-speaking="true"]`, nome em `[data-tid="participant-info-nametag"]`), sem o seu nome. Duas fontes dizem que ele está sem sinal no Teams v2 atual; fica por último, só sem os outros dois.
As legendas (`recognitionResults`, que só existem com a legenda ligada neste cliente) ficaram de fora: ligar muda a tela do usuário.

**Ganchos novos e as regras do MAIN world.**
- `RTCPeerConnection.prototype.createDataChannel` embrulhado: o original primeiro, o mesmo canal de volta (regra 1). Cada PC registrado ganha um listener de `datachannel` (o canal que o outro lado abre). Nos canais com o rótulo que o adaptador pediu (`collections` e `dcrpc` no Meet, `main-channel` no Teams), um listener passivo de `message` pelo `addEventListener` original; nada é enviado e nenhum handler da página é trocado (`speakers/channels.ts`).
- `window.fetch` embrulhado só no Meet (`speakers/fetch-tap.ts`): para qualquer outra URL, a página recebe a promise do original; para a URL da roster, a promise derivada que resolve com a mesma `Response` (ou rejeita com o mesmo motivo), como o `getUserMedia` da Emenda 5, e um `clone()` é lido sem esperar.
- `getContributingSources()` é chamado pela própria extensão (só leitura), nunca espelhado das chamadas da página (o espelho congela com a aba em segundo plano). Nada de `createEncodedStreams` (regra 5).
- Toda promise nossa tem tratador (a descompressão nunca rejeita); nada lança para a página.
- Originais novos: `pcCreateDataChannel`, `receiverGetContributingSources`, `dataChannelLabelGet`, `fetch`, `DecompressionStream`, `atob`, `timeOrigin`.

**A sua fala.** O microfone continua fora da gravação (produto). O registry guarda as faixas de áudio do `getUserMedia` (não as do `getDisplayMedia`) e o mixer liga cada uma, pelo construtor original, só num `AnalyserNode` próprio do nosso `AudioContext` (`measureMic`), nunca no destino gravado nem em saída nenhuma (regra 4). Acima de `MIC_SPEECH_DBFS` (-45 dBFS, mais alto que o limiar dos seams por causa do ruído de fundo e do resto de eco; opinião, a medir) é você falando: intervalos com `voce: true` e `fonte: 'microfone'`. Um microfone desligado pela página (`enabled = false`) mede silêncio.

### No SW

- `session:speakers` só de sessão de página: `applySpeakersBatch` (`src/shared/speakers.ts`) troca tudo de `from` em diante; um `from` além do guardado não mexe nos intervalos (o fim manda a linha inteira) e o `aliases` vale sempre. Fica no `SessionRecord.speakers` (IndexedDB, sobrevive ao SW reiniciar). Descartada por ser curta, some com o `meta` (os nomes não ficam no perfil).
- No fim, `speakersOutput` resolve os nomes (chave provisória pelo `aliases`, senão `Participante N`/`Participant N` na ordem da primeira fala; você como `Você`/`You`, pelo `chrome.i18n`), junta os intervalos da mesma pessoa que se encostam e soma o tempo de cada um sem contar duas vezes a sobreposição. **Só com algum intervalo de participante**: só o microfone não diz quem falou na call, e aí nada muda na pasta.
- O `falantes.json` vai pelo `finalize` do helper (`extras`, novo, escrito antes do `info.json`; o helper só aceita os nomes de `EXTRA_FILES`, hoje só `falantes.json`) e pela reserva de Downloads (baixado antes do `info.json`, pela mesma via do `downloadInfo`). O modo aba que entra na pasta da página não manda o dele. `info.json.falantes`: `{ arquivo, pessoas: [{ nome, segundos, voce? }], fontes }`.

`falantes.json`:

```json
{
  "versao": 1,
  "audio": "audio.webm",
  "atrasoMs": 1500,
  "intervalos": [{ "nome": "Ana Souza", "de": 2500, "ate": 8750, "fonte": "dsh" }, { "nome": "Você", "voce": true, "de": 14500, "ate": 18750, "fonte": "microfone" }],
  "pessoas": [{ "nome": "Ana Souza", "segundos": 6.3 }, { "nome": "Você", "segundos": 4.3, "voce": true }],
  "textos": { "voceNaoGravada": "(sua fala não é gravada)" }
}
```

### Helper e transcrição (`HOST_VERSION` 0.4.0)

- O worker lê o `falantes.json` da pasta só para o áudio que ele diz (`audio.webm`); o `audio-aba.webm` sai como antes. Sem o arquivo, sem nenhum participante, ou com o arquivo inválido, a saída é idêntica à de antes (teste byte a byte contra o texto da 0.3.1 copiado no teste, com segmentos fora de ordem e com o mesmo início; a primeira versão reordenava os parágrafos pelo início e mudava esse caso). As linhas da sua fala entram antes do primeiro parágrafo que começa depois delas, sem reordenar os outros.
- Os nomes vêm da página (qualquer participante escolhe o dele): `cleanSpeakerName` troca caracteres de controle, separadores de linha e de parágrafo do Unicode e marcas de direção do texto por espaço; no `.md`, os sinais de markdown e de HTML do nome ganham a barra invertida (`mdName`); no `.srt`, `<`, `>`, `{` e `}` viram `‹`, `›`, `(` e `)` (`srtName`), porque os players leem `<i>`, `<font>` e `{\an8}`.
- `assignSpeakers`: cada segmento do whisper fica com o participante de maior sobreposição; empate, o de intervalo mais longo; depois, o que começou antes; sem sobreposição, sem nome. Nunca você (a sua voz não está no áudio).
- `mergeSegments`: a troca de falante começa outro parágrafo, mesmo sem pausa.
- `transcricao.md`: `[mm:ss] Nome: texto`. Onde você falou e a gravação não tem fala da call (os segmentos cobrem menos da metade do intervalo, e o intervalo tem 1 s ou mais), uma linha `[mm:ss] Você: (sua fala não é gravada)` entra na ordem do tempo (o texto vem de `textos.voceNaoGravada`, no idioma da interface). `transcricao.srt`: `Nome: ` antes do texto de cada bloco com falante.
- Um helper anterior ignora o `extras`: a pasta fica sem o `falantes.json` (o resumo no `info.json` continua) e a transcrição sai sem nomes. `npm run instalar` de novo.

### Testes

Unidade (cada um conferido vermelho com a mutação indicada e verde de volta): `timeline.test.ts` (atraso ignorado, sem histerese, lote sem `from`, sem o corte do intervalo aberto há 30 s, `closeAll` sem cortar no fim do áudio), `session.test.ts` (o controlador com mixer e gravador falsos e um SW que perde um lote: sem a linha inteira no `finish` ou no `pagehide`, sem o corte no fim do áudio do `pagehide`, sem o `remoteSpeech` no probe), `fetch-tap.test.ts` (promise derivada para qualquer URL, rejeição trocada, URL do `Request` ignorada), `channels.test.ts` (sem o limite da descompressão, rejeição solta), `csrc.test.ts` (presença contando como fala, sem o nível, sem o `timeOrigin`), `meet-signals.test.ts` (sem o filtro de space, flag 9.2 ignorada, busca só no primeiro nível), `meet-speakers.test.ts` (dcrpc antes do CSRC, sem alias, primeira leitura do medidor contando, device de outra call fora da roster virando "Participante N"), `teams-speakers.test.ts` (sem os `mediaStreams`, JSON só a partir do primeiro `[`, você virando falante pelo CSRC, o seu bloco no DOM, o `dsh` valendo no silêncio, o `dsh` valendo depois de o canal fechar), `registry-falantes.test.ts` (sem o aviso do `createDataChannel`, sem o `datachannel`, áudio da tela como microfone, CSRC de faixa local), `src/shared/speakers.test.ts` (sem alias, soma dobrada, só o microfone gravando, lote fora de ordem aplicado), `sessions.test.ts` (lote ignorado, sem `extras` no helper e nos Downloads, descarte guardando os nomes, lote aceito depois de salva ou descartada), `gravador-host.test.ts` (extras com qualquer nome, sem extras, sem o limite de 8 MB, limite contado em caracteres), `transcricao-falantes.test.ts` (golden da 0.3.1, nome sem saneamento no `.md` e no `.srt`, empate invertido, parágrafo sem troca de falante, você recebendo segmento, sem a sua linha, cobertura ignorada, `.srt` sem nome, worker sem ler o `falantes.json`).

Ponta a ponta, `tests/e2e/falantes.spec.ts`, com o whisper-cli falso emitindo segmentos em tempos conhecidos (`segmentos.json`, `fakeSegments`) e o roteiro contado do `startedAt` da gravação: Teams com o `dsh` no `main-channel` (a Ana pelo `hasAudioSource`, o Bruno pelos `mediaStreams`, você pela fonte do `localSignalingParticipant` e pelo microfone falso ligado de 13 a 17 s); Teams só com o indicador do bloco (o seu bloco acende e não conta); Meet com a roster pelo `collections` (do outro lado) e pelo `SyncMeetingSpaceCollections`, quem fala pelo `dcrpc` (por `deviceId` e por id numérico), uma pessoa de outra call que nunca aparece e o seu device ignorado. Cada um confere as linhas do `transcricao.md` na ordem, o `.srt`, o `falantes.json` e o resumo do `info.json`. Mutações conferidas vermelhas: sem o atraso do mixer, sem o `main-channel`, sem o indicador do bloco, sem o fetch da roster, sem o `collections`, sem a sua fala. O CSRC não tem ponta a ponta: numa conexão direta entre duas abas o Chrome não manda CSRC; ele fica nos testes de unidade.

### Não feito, ou para medir numa call real

- **Validação numa call real com várias pessoas, no Meet e no Teams (pendente, só o usuário):** quais rótulos de canal aparecem no `chrome://webrtc-internals`, se `String(csrc)` bate com algum `streamId` do `collections`, se o Meet do usuário está no caminho nativo ou no NetEq, o comportamento com três abas em segundo plano, se o `hasAudioSource` do Teams resolve o CSRC e o `dsh` no Chrome 154, e o limiar do microfone (-45 dBFS) com o ruído de um escritório.
- Teams com o microfone mudo no aplicativo mas a faixa ligada: a sua fala pode aparecer como "Você" sem ninguém ter ouvido (não medido).
- Legendas (Meet e Teams) como fonte opcional, ligada pelo usuário.
- O medidor do DOM do Meet só funciona com a aba visível; em segundo plano, só a rede.
- Os tempos não descontam lacunas de chunks.
- Política de privacidade (`site/privacidade.html` e `site/en/privacy.html`) atualizada com o `falantes.json` e a medida do microfone; o site **não** foi publicado de novo e a divulgação de dados da loja não mudou de caixas (os dados continuam os mesmos tipos: nomes e comunicação, só no computador). Publicar e reenviar fica com o usuário.

O contrato que nenhuma parte muda sozinha passa a incluir `SpeakerInterval`, `SpeakerSource`, `session:speakers`, `InfoJson.falantes` (`InfoSpeakers`), `SpeakersFile`, `HostExtraFile` e o `extras` do `finalize`, `MIXER_DELAY_MS`, `SPEAKER_KEY_PREFIX`, `SPEAKERS_FILE`, `MAX_SPEAKER_INTERVALS`, os três ganchos do adaptador e as chaves `speakerYou`, `speakerUnknown` e `speakerYouNotRecorded`.

## Emenda 19: idioma escolhido nas configurações (09/10/2026, 0.4.1)

Pedido do usuário (09/10/2026): "quero que nas config tenha a opção de lingua pt ou en dai ao alterar, ajusta todos". Esta emenda **acrescenta**; com o idioma em Automático (o padrão, e o de toda configuração guardada antes da 0.4.1) tudo sai exatamente como antes, inclusive pelo `chrome.i18n.getMessage`.

**Por que a extensão formata as mensagens.** O `chrome.i18n` escolhe o `messages.json` pelo idioma da interface do Chrome e não deixa trocar em tempo de execução. Com Português (Brasil) ou English escolhidos, as mesmas mensagens de `public/_locales` vão embutidas no bundle (import do JSON) e `formatMessage` (`src/shared/i18n.ts`) aplica a semântica medida no Chrome for Testing 151 (Emenda 15): placeholders com nome (`$NOME$`, sem diferenciar maiúsculas) viram o `content`; depois `$1`..`$9` viram os valores, um valor ausente vira vazio e `$$` vira `$`; chave inexistente, `''` (o `t()` troca pela chave). O `chrome.i18n` falso dos testes (`tests/helpers/i18n-fake.ts`) passou a usar o mesmo `formatMessage`, e um teste confere que, em toda chave, o idioma escolhido dá exatamente o texto que o `chrome.i18n` daria naquele idioma.

**Configuração.** `Settings.language: 'auto' | 'pt_BR' | 'en'` (`UI_LANGUAGES` em `constants.ts`, `UiLanguage` em `protocol.ts`), por perfil, em `chrome.storage.local` junto das outras. `normalizeSettings`: ausente ou inválido vira `auto` sem derrubar os outros campos. `languageOf` (`i18n.ts`) lê o mesmo campo sem zod: o content script do vigia não carrega os schemas.

**`src/shared/i18n.ts`.**
- Estado por contexto: `uiLanguage()`, `setLanguage()`, `onLanguageChange(cb)`.
- `initLanguage()`: uma vez por contexto (a mesma promessa depois), registra o ouvinte do `storage.onChanged` **na mesma volta do laço** e lê o `settings`. No SW é o ouvinte que recebe a mudança que acordou o SW; uma mudança que chegue antes da leitura vale mais que ela. Nunca rejeita (sem storage, fica `auto`) e, se o storage não responder em 2 s, segue com o que já vale.
- `languageReady()`: resolve quando a leitura terminou (ou na hora, sem `initLanguage`).
- `t()`, `tp()` e `messageLocale()` seguem o escolhido (o plural pela regra dele); `tIn(locale, chave)` formata num idioma dado (o SW reconhece os títulos das duas línguas).
- `downloadsFolderName()` fica **pelo idioma do Chrome**, qualquer que seja o escolhido: trocar o idioma não divide as gravações de reserva em duas pastas. O texto em volta (popup, configurações, boas-vindas) segue o escolhido.
- Sem zod e sem React: vai no SW e no vigia. O hook mora em `src/shared/page-language.ts`.

**Páginas** (popup, configurações, boas-vindas). `preparePageLanguage(título)` espera o `initLanguage` antes do `createRoot().render` (a página não pisca no idioma do Chrome), põe o `<html lang>` e o título e os refaz a cada troca. A raiz de cada página chama `useLanguage()` (`useSyncExternalStore` sobre `onLanguageChange`); os filhos redesenham junto, e o estado do React (o que foi digitado) continua.

**Configurações.**
- Seção "Idioma" no topo (preferência geral): "Automático (idioma do Chrome)" no idioma atual, e "Português (Brasil)" e "English" sempre na própria língua (`UI_LANGUAGE_OPTIONS` em `form.ts`, com `lang` em cada `<option>`; os nomes das línguas não passam por `t()`, porque não são tradução). O seletor mostra o `uiLanguage()` da página e não faz parte do formulário (`ProfileForm` e `profileFormSchema` sem `language`).
- Mudar: `setLanguage` na hora (a página troca antes do storage responder) e salva sozinho, sem o Salvar; sem salvar, a página volta ao idioma de antes e diz por quê.
- `saveStored`: o nome do perfil (salvo ao sair do campo, Emenda 10), o idioma e o Salvar passam por uma fila que lê o guardado e troca só o seu campo, um por vez. Sem ela, o clique no seletor tira o foco do nome do perfil e os dois salvamentos juntos podiam desfazer um ao outro. O Salvar mantém o idioma guardado.
- As mensagens guardadas na tela (pasta, transcrição, nome do perfil, Salvar, idioma) são funções lidas a cada render, e `useRetranslatedErrors` valida de novo os campos com erro na troca de idioma: a mensagem do resolver troca junto.

**SW.**
- `index.ts` chama `initLanguage()` antes de registrar os ouvintes.
- Esperam `languageReady()` antes de criar texto: `setBadge` e `applyGlobalBadge` (títulos), as notificações de `badge.ts` e a do vigia (`vigia.ts`), toda resposta da `ui-api.ts` (erros e motivos das telas) e o `doFinalize` (nomes da pasta, rótulos dos falantes e o `idiomaInterface`). É a corrida do SW que acorda: o evento que o acordou pode chegar antes da leitura.
- `refreshActionTitles` (`badge.ts`, ligado ao `onLanguageChange` no `registerBadge`): o título global de novo e, em cada aba, o título próprio de REC, REC âmbar ou ↻ no idioma novo. O SW não guarda o estado de cada aba (o título sobrevive no Chrome a um reinício do SW), então `tabStateOfTitle` o reconhece pelo título, nas duas línguas. O título padrão e os globais nunca são postos numa aba (a prenderiam ali).
- Fila do badge (`inBadgeQueue`, uma por aba e uma do global): o `setBadge`, o `applyGlobalBadge` e o passo de cada aba da troca rodam um por vez, e cada um lê o estado e o idioma na sua vez. Sem ela, um `setBadge` começado antes da leitura do título e terminado depois dela deixava a aba sem badge com o título de "gravando esta call" (medido pela verificação: 25 a 32 em 300 no Chrome for Testing), e um badge global começado antes da troca escrevia o título em português depois do inglês. A fila substituiu o contador `badgeChanges`, que só pegava o `setBadge` começado depois da leitura.
- Notificação já mostrada fica como saiu; as novas saem no idioma novo.

**Vigia (content script).** `mostrar` recebe uma função da leitura (`() => string`, com os números da leitura copiados), não o texto pronto; `idiomaMudou()` reescreve o indicador na hora com a mesma leitura, sem esperar a próxima. O vigia espera o `initLanguage` antes de conectar o Port.

**Helper (`HOST_VERSION` 0.4.1).** A extensão grava `idiomaInterface` (`interfaceLanguage()` em `info.ts`: `pt-BR` ou `en`, pelo `localeTag` que vale) só com o idioma escolhido; no Automático, `null` e o campo fica de fora, então o cabeçalho sai em português, como antes da 0.4.1, mesmo num Chrome em inglês (os rótulos dos falantes continuam pelo idioma do Chrome, como na 0.4.0). Decisão: a verificação mostrou que gravar o idioma do Chrome no Automático mudava o cabeçalho de quem usa o Chrome em inglês, e o Automático é, por decisão, igual ao de antes. `host/transcricao.mjs`: `MARKDOWN_LABELS` (`pt-BR` e `en`) e `markdownLanguage(info)` (só um valor conhecido, por `Object.hasOwn`; ausente ou outro, `pt-BR`); `buildMarkdown` escreve com eles os rótulos do cabeçalho, "Untitled", "Other site", "not identified", "(tab mode)" e a linha da fala vazia; `formatLocalStart(iso, 'en')` dá a data como o popup mostra ("Oct 6, 2026, 2:30 PM"). Duração, nomes de plataforma e de motor, título, participantes e a fala não mudam. Os rótulos dos falantes e o texto da sua fala já vinham no idioma da interface pelo `falantes.json` (Emenda 18). Um helper anterior ignora o campo e escreve em português; `npm run instalar` de novo.

**Tamanho dos bundles** (antes e depois, `npm run build:only`, com o fecho dos imports estáticos): `dist/src/content/vigia/vigia.js` 15,9 KB (6,1 KB gzip) para 67,1 KB (20,0 KB gzip); o SW 178,5 KB (55,9 KB gzip) para 230,4 KB (70,1 KB gzip); popup, configurações e boas-vindas cerca de 52 KB a mais cada (o chunk do i18n com as duas línguas é compartilhado entre elas). O offscreen, que não mostra texto, caiu de 14,5 KB para 13,0 KB: o `BAKED` foi para `src/shared/baked.ts`, sem dependências, e ele não carrega mais o i18n. Decisão declarada: as duas tabelas inteiras vão também no vigia, em vez de um subconjunto de chaves só dele, porque o content script não pode buscar o `_locales` sem `web_accessible_resources` (que o projeto evita desde a Emenda 10) e um subconjunto teria de ser mantido à mão.

**Motivos guardados já traduzidos.** O SW escreve os motivos dele no idioma da hora, e alguns ficam guardados assim: o status do helper (`lastStatus`, cache de 15 s, com `errHelperTimeout` ou `errHelperDisconnected`), o `lastError` de uma gravação não salva (`errNoWritePermissionAt`, `errDownloadTimeout`, `errBlobUrl`...), o `trOldHelper` da transcrição e o erro de uma ação que a tela mostra. Em vez de mudar o protocolo para mandar chave e valores, a tela os reconhece pelo texto, como `tabStateOfTitle` faz com os títulos: `recognizeMessage(texto, chaves)` (`i18n.ts`) monta de cada mensagem das duas línguas uma expressão com o texto fixo literal e cada `$n` um grupo, e devolve a chave e os valores; formatar de novo na mesma língua dá o mesmo texto. `helperReason` (`helper-reasons.ts`) passa a reconhecer, depois das regras do helper, todas as mensagens `err*` e o `trOldHelper`, e passa os valores pelo mesmo `helperReason`. Ele já era chamado onde o motivo aparece; agora também no `helperProblem` (a frase "instalado, mas não abre"), no status do helper e no erro da transcrição das configurações, no erro inesperado e nos erros das ações. Regras novas do helper (os do worker da transcrição que faltavam desde a Emenda 15): ffmpeg e whisper-cli passando do tempo, whisper-cli sem o JSON, a transcrição interrompida 3 vezes, `áudio não encontrado: <arquivo>`, `motor de transcrição indisponível` e `motor desconhecido: <id>` (chaves `hrFfmpegTimeout`, `hrWhisperTimeout`, `hrWhisperNoJson`, `hrInterrupted`, `hrAudioMissingFile`, `hrEngineUnavailable`, `hrUnknownEngine`).

**Mensagens das telas.** As mensagens guardadas no estado do React são o motivo cru ou uma função, e a frase sai a cada render: no popup (modo aba, volume, devolução, parar, vigia, "Mostrar no Finder", abrir a transcrição, "Tentar agora" das não salvas), nas boas-vindas (o erro do "Entendi") e no `useUnhandledUiErrors` do popup e das configurações (`VersionBanner.tsx`), além das configurações, que já faziam assim. As últimas gravações guardam o título cru (`cleanTitle` em `naming.ts`; vazio sem título nem código), e o popup põe o "Sem título" do idioma que vale; o `info.json` e o nome da pasta continuam com o `displayTitle`.

**Não muda de idioma** (o Chrome não permite, ou foi decidido assim):
- O nome e a descrição da extensão em `chrome://extensions` e na loja, e a descrição do atalho do modo aba: vêm do manifesto por `__MSG_`, que só o `chrome.i18n` resolve.
- A pasta raiz de reserva em Downloads (`Gravações de calls` ou `Call recordings`), pelo idioma do Chrome. Os nomes de pasta de cada gravação (`Sem título`/`Untitled`, `(Outro site)`/`(Other site)`) seguem o escolhido.
- O staging órfão (`Gravação recuperada`, só com o helper) continua em português e sem `idiomaInterface`.
- O log do vigia e do SW no console.
- Um motivo que não é mensagem nossa nem regra do helper (o texto do próprio Chrome, como "Native host has exited.", ou um motivo novo do helper) aparece como veio.
- As últimas gravações sem título guardadas antes da 0.4.1 continuam com o "Sem título" de quando foram salvas.

**Testes.** Unidade (cada um conferido vermelho com a mutação indicada e verde de volta): `src/shared/i18n.test.ts` (o `formatMessage` com `$n`, valor ausente, `$$`, placeholders sem diferenciar maiúsculas e mensagem ausente; o fake igual ao formatador; o escolhido igual ao `chrome.i18n` do outro idioma em toda chave, nos dois sentidos; `t`, `tp` e `messageLocale` com `auto`, `pt_BR` e `en`, inclusive o plural do 0; a pasta de Downloads presa ao Chrome; `languageOf`; `onLanguageChange` com ouvinte que falha; `initLanguage` com a mudança antes da leitura, a área `sync`, sem storage, storage com erro, configuração antiga e o limite de 2 s; mutações: sem `$$`, placeholder sem minúsculas, tabelas trocadas, `t` ignorando o escolhido, Downloads pelo escolhido, a leitura valendo mais que a mudança, `languageReady` sem esperar, valor ausente como `undefined`, sem o limite, ouvinte que derruba os outros, área `sync` contando, `languageOf` aceitando qualquer texto), `settings.test.ts` (ausente e inválido viram `auto` sem derrubar os outros campos, e o `languageOf` dá o mesmo que o `normalizeSettings`), `badge.test.ts` (o estado pelo título nas duas línguas, a troca reaplicando o global e as abas com REC e ↻ sem prender o padrão, o `registerBadge` reagindo sozinho, a aba que mudou durante a troca, o `setBadge` começado antes da troca e terminado depois dela, o badge global começado antes da troca, a notificação e o título esperando a leitura do idioma; mutações: notificação e `setBadge` sem esperar, sem a guarda da troca, o padrão preso nas abas, sem o global, só a língua atual reconhecida, sem registrar a troca; os dois casos da fila conferidos vermelhos com o contador de antes), `sessions.test.ts` (sem `idiomaInterface` no automático, num Chrome em português e num em inglês, `pt-BR` com Português escolhido, e em inglês com "You" e o texto da sua fala; as últimas gravações sem título guardam vazio), `helper-reasons.test.ts` (os motivos do SW de toda chave `err*` e o `trOldHelper` iguais no idioma em que foram escritos e no idioma novo depois da troca, nos dois sentidos, com valores que também são motivos; os sete do worker), `helper-status.test.ts` (a frase do helper que não abre sem português depois da troca), `i18n.test.ts` (`recognizeMessage` em toda chave e nas duas línguas, só o texto inteiro, só as chaves pedidas, caracteres de expressão regular como texto), `form.test.ts` (o formulário sem o idioma), `vigia-source.test.ts` (o `mostrar` só com funções), `tests/unit/transcricao.test.ts` (o cabeçalho em inglês inteiro, a data em inglês com meia-noite e meio-dia, e sem o campo ou com `pt-BR`, `es`, `constructor`, `__proto__`, um número ou `null`, o mesmo texto de antes) e `tests/unit/transcricao-falantes.test.ts` (o worker com o `info.json` em inglês e o `falantes.json` com "You").

Ponta a ponta, `tests/e2e/idioma-escolhido.spec.ts`, num Chrome for Testing em português (o `chrome.i18n` continua `pt-BR` o tempo todo): com as boas-vindas abertas (aviso sem confirmar, para o título global ter texto nas duas línguas), uma aba com REC pelo gancho `setBadge`, o popup aberto e um campo mexido com a mensagem de erro do Salvar, escolher English troca na hora as configurações (cabeçalhos, `lang`, título, a mensagem de erro, o valor digitado continuando lá), as boas-vindas e o popup abertos, o título global e o da aba com REC; fica guardado; um popup aberto depois nasce em inglês; o Salvar guarda o campo e não desfaz o idioma; recarregada, a página nasce em inglês (o primeiro título que aparece já é "Language", com `lang="en"`); Automático volta tudo ao português; e uma troca feita em outra aba das configurações chega à primeira inteira. O indicador do vigia numa call falsa do Teams com uma leitura a cada 30 s troca para inglês e volta em até 5 s, sem leitura nova no meio. Com o SW parado (CDP), a troca gravada direto no storage por uma página da extensão, sem mensagem ao SW, o acorda e o título do ícone muda. Mensagens já na tela, conferidas vermelhas sem a correção: nas configurações com o helper de antes da transcrição, o erro da transcrição e um erro inesperado com o motivo do `uiCall` trocam inteiros para o inglês e voltam; com um helper que não responde ao ping, a frase "instalado, mas não abre" das configurações e do popup e o status do helper saem inteiros em inglês; no popup aberto, os erros do modo aba e do volume (a captura presa por outra extensão) trocam inteiros; nas boas-vindas abertas, o erro do "Entendi" troca inteiro. Mutações conferidas vermelhas: sem esperar o idioma antes do render, o SW sem reaplicar os títulos, as boas-vindas sem o hook, a raiz das configurações sem o hook, o vigia sem reescrever, o Salvar sem manter o idioma, sem a retradução dos erros e o SW sem o `initLanguage`. O popup sem o hook continua passando: ele já redesenha a cada 1 s pelo `ui:state`, e o hook só torna a troca imediata.

**Não feito.**
- A conferência num perfil de verdade do Chrome 154 (o teste usa o Chrome for Testing 151).

O contrato que nenhuma parte muda sozinha passa a incluir `Settings.language` e `UI_LANGUAGES`, `InfoJson.idiomaInterface` (`InfoLanguage`, opcional: só com o idioma escolhido), `formatMessage` como a semântica do `chrome.i18n`, `recognizeMessage` como o inverso dele, `MARKDOWN_LABELS` no helper e as chaves `optSectionLanguage`, `optLanguageAuto`, `optLanguageHint`, `optLanguageSaved`, `optLanguageCannotSave`, `hrFfmpegTimeout`, `hrWhisperTimeout`, `hrWhisperNoJson`, `hrInterrupted`, `hrAudioMissingFile`, `hrEngineUnavailable` e `hrUnknownEngine`. Um texto de motivo do helper que mudar precisa mudar junto a regra em `helper-reasons.ts`.

## Emenda 20: a primeira daily real do Meet (13/10/2026, 0.4.2)

Pedido do usuário (13/10/2026): a 0.4.1 gravou uma daily real do Meet (8 min 37 s, 6 pessoas além dele) e "funcionou a call, também pegou alguns participantes, só faltou pegar o nome; veja se dá para melhorar alguma coisa". Esta emenda **acrescenta** e corrige o que a call mostrou. É a primeira vez que os sinais da Emenda 18 foram vistos numa call de verdade. Nada da gravação (áudio, nomes, falas) entra no repositório: a fixture derivada dela (`tests/fixtures/falantes/daily-meet-anonimizada.json`) só guarda os tempos, com as pessoas trocadas por letras.

**O que a call mostrou.** A gravação, os participantes e a transcrição funcionaram, mas 330 dos 350 trechos do whisper saíram como "Participante 1". O `info.json` veio com `voce: ""` e o próprio usuário na lista de participantes, o título caiu no código da reunião (a aba dizia `Meet: <código>`, o formato pt-BR com dois-pontos, visto ao vivo pela primeira vez), o `helper` dizia 0.4.0 uma hora depois de um `npm run instalar` da 0.4.1, e o whisper repetiu uma frase em quatro trechos seguidos e esticou a cópia de outra por cima de um silêncio de 26 s.

### A. A fonte sem nome que acompanha quem fala

**Causa.** "Participante 1" era uma chave provisória de um CSRC que nunca resolveu na roster. Ficou ativa 399,5 s, 98,7% desse tempo junto de alguma das 6 pessoas nomeadas, presente em 99,2% do tempo em que elas falavam; em 42 de 42 intervalos o fim dela caiu no mesmo ms do último falante nomeado, e em 38 de 42 o começo também (nos outros 4, o nomeado começou de 250 a 1000 ms antes, nunca depois). O `assignSpeakers` dá cada trecho a quem tem mais sobreposição (empate: o intervalo mais longo), então ela ganhava quase sempre. O cliente de referência do próprio Google para a Meet Media API (`googleworkspace/meet-media-api-samples`) trata o CSRC 42 como reservado: `kLoudestSpeakerCsrc = 42` em C++ ("Meet uses this magic number to indicate the loudest speaker") e `LOUDEST_SPEAKER_CSRC = 42` na web, e os dois o tiram antes de escolher o participante. É inferência forte, não confirmação: o `falantes.json` da 0.4.1 não guardava o número do CSRC (o diagnóstico abaixo confirma na próxima call).

**No Meet** (`platforms/meet-speakers.ts`): `MEET_LOUDEST_SPEAKER_CSRC = 42` sai dos CSRCs ativos antes do `nameOf`, como o próprio usuário e as apresentações. Fica no adaptador, e não no `CsrcTracker`, que o Teams também usa. Se um participante de verdade recebesse o 42, ele sumiria; o Google trata o valor como reservado.

**Regra genérica, para o Meet e o Teams** (`checkUnnamedSources` e `UNNAMED_SHADOW` em `src/shared/speakers.ts`, a mesma regra em `host/transcricao.mjs`). Uma fonte **sem nome** (chave provisória que nem a roster nem o `aliases` resolveram) sai da linha do tempo e de `pessoas` quando:
- do tempo ativo dela, pelo menos **85%** teve alguma pessoa nomeada falando junto (`coberturaPct`); e
- do tempo em que as nomeadas falaram, ela esteve ativa junto em pelo menos **50%** (`presencaPct`).

Medido na daily, com cada pessoa de verdade tratada como se fosse a sem nome contra as outras: cobertura de 0,4% a 15,4% e presença de 0,1% a 3,1%; a fonte sem nome, 98,7% e 99,2%. As duas condições juntas separam o marcador (só existe com alguém falando, e quase sempre que alguém fala) de quem fala sozinho (cobertura baixa), de duas pessoas que às vezes falam juntas (cobertura baixa) e de quem só faz interjeições por cima dos outros (cobertura alta, presença baixa). Decisão declarada: a presença no lugar de "acompanha 3 ou mais pessoas nomeadas", porque 3 das 6 pessoas reais da mesma call já se sobrepuseram a 3 outras (não discrimina) e porque numa call de 2 ou 3 pessoas o marcador só tem 1 ou 2 para acompanhar. Uma chave resolvida e um nome dado pela plataforma nunca saem. A descartada não gasta número: a próxima sem nome continua sendo "Participante 1".

No SW, o `speakersOutput` aplica a regra antes de numerar e escreve no `falantes.json`:
- `descartadas: [{ chave, segundos, coberturaPct, presencaPct, pessoasCobertas }]`, só quando alguma saiu; `chave` é o tipo e o id sem o prefixo (`csrc:42`), nunca um nome;
- `semNome: true` em cada pessoa de `pessoas` cujo rótulo é nosso ("Participante N"), também no resumo do `info.json`.

O helper (`speakerTimelineFrom`) aplica a mesma regra ao ler o `falantes.json`: sem nome é o que traz `semNome`, ou, num arquivo de antes da 0.4.2, o rótulo `Participante N`/`Participant N`. O worker escreve no log cada fonte descartada (segundos e porcentagens, sem nome). Assim uma gravação de antes, transcrita de novo (`npm run transcrever`, item F), sai certa. Um participante de verdade chamado literalmente "Participante 3", num arquivo antigo, seria tratado como sem nome; só sairia se também acompanhasse quem fala.

**Diagnóstico de CSRC, só com números** (`falantes.json.diagnostico.csrc`). O registry passou a dizer de qual receptor veio cada entrada (`ContributingSource.receiver`, um número estável por `RTCRtpReceiver` num `WeakMap`, nunca o objeto). O adaptador do Meet conta, para cada CSRC ativo (o 42 também, até 64 acompanhados): em quantas leituras ficou ativo, em quantos receptores apareceu, se a roster o resolve, em quantas leituras estava **no mesmo pacote** de uma pessoa com nome (outra entrada no mesmo receptor com o mesmo `timestamp` e o mesmo `rtpTimestamp`, porque a libwebrtc copia os dois do pacote para cada CSRC dele) e por que foi ignorado (`mais-alto` para o 42, `roster` para o próprio usuário, uma apresentação ou outra call). Vai no lote final do `session:speakers` (campo opcional `diagnostico`; gancho opcional `speakerDiagnostics()` do adaptador), com as 32 fontes mais lidas e `receptores` (quantos receptores mandaram CSRC). O zod do SW só deixa passar os campos numéricos conhecidos: uma chave a mais sai calada, sem recusar o lote (que leva a linha do tempo inteira). O helper 0.4.0 ignora o campo.

### B. O próprio nome no Meet

A 0.4.1 só lia o `[data-self-name]` do DOM, que não existia na call real. Agora (`meet-signals.ts`, `meet.ts`):
1. **Roster.** O `UserInfo` com o campo 7 (`isCurrentUserString`) **verdadeiro** é o próprio usuário. Leitura tolerante, a do Meeting-BaaS (`isCurrentUser`): texto não vazio e diferente de `false` e de `0`, ou varint diferente de 0. Antes bastava a presença do campo, e um `false` faria de qualquer participante o próprio usuário (e o tiraria da linha do tempo). O `MeetRoster` guarda o registro do próprio usuário **por space** (`selves`) com o nome completo (campo 2) e o exibido (29); `self()` devolve o do space da call. `info.voce` recebe o nome completo, senão o exibido, porque os participantes vêm do DOM com o nome completo (na call, o 29 era o primeiro nome).
2. **Space da call** (`MeetRoster.callSpace`): o dos `data-participant-id` dos blocos, que só mostram esta call, lido no `readMeta` e no `refreshDom`. Ele vale mais que o `selfSpace` (o do primeiro registro do próprio usuário a chegar, que pode ser de outra call da mesma conta) para escolher o registro e para o filtro de "outra call" (`sameCall`). Antes, com a conta em duas calls, o primeiro registro fixava o space e podia filtrar as pessoas desta.
3. **Reserva**: o `[data-self-name]`, como antes. A roster vale mais que ele.
4. **Fora dos participantes**, pelo device: o rótulo lido do bloco cujo `data-participant-id` é o device do próprio usuário sai, inclusive o lido antes de a roster chegar e um rótulo diferente do nome; e pelo nome. O SW tira de novo o `selfName` dos participantes juntados de todas as leituras (`buildInfo`), porque um nome que chegou depois ficava na união.

Diagnóstico no `info.json`: `voceSinais: { roster, espacos, marcadorDom }` (o nome veio da roster no space da call; quantos spaces a roster mostrou; o marcador do DOM apareceu). **O campo 7 no registro do próprio usuário nunca foi visto numa call deste projeto**: as fixtures o montam a partir da descrição de terceiros. A call real só prova que os 6 colegas não o traziam (todos resolveram nome). Se ele não vier, a regra cai no DOM e `voce` continua vazio; o `voceSinais` da próxima call diz qual foi o caso.

### C. O título no Meet

Nada novo com evidência: o TranscripTonic, extensão em produção, lê o mesmo elemento e pede um título ao usuário quando ele mostra o código, e nesta call o próprio Meet pôs o código na aba. O provável é que a conta não conheça o evento. O painel "Detalhes da reunião" exige clique (fora das regras). Fica um **diagnóstico passivo** no `info.json`: `tituloSinais: { elemento: 'ausente' | 'codigo' | 'outro', seletor: 'NeC6gb' | 'u6vdEc' | null, abaIgualCodigo }`, com o mais forte visto na call (`outro` vale mais que `codigo`, que vale mais que `ausente`). Na próxima daily: se o canto inferior esquerdo da call mostrar o nome do evento e o `info.json` disser `codigo`, o seletor quebrou; se mostrar o código, não há fonte passiva.

### D. O helper antigo continuava rodando

**Causa** (medida com `pgrep`, `ps`, `lsof`, o `owner.json` e o `info.json`). É um processo do helper por perfil, e ele vive enquanto o SW daquele perfil segura o Port nativo. O fim da gravação e a passada da recuperação soltavam o Port, mas o popup (`ui:state` a cada 1 s, `transcription-status` a cada 2 s) e as configurações o abriam e ninguém fechava; como o `connectNative` mantém o SW vivo, o processo ficava aberto sem prazo (um deles, havia 3 dias e 17 horas, com 0,08 s de CPU). Depois de um `npm run instalar`, esse processo continua com o código antigo na memória; o worker da transcrição sai do disco, então a daily foi transcrita com o código novo e só o `helper` do `info.json` ficou errado, mas uma mudança no próprio `gravador-host.mjs` se perderia sem aviso. As frases "o próximo ping (em até 15 s) já encontra o helper" (`instalar.mjs`) e "Não é preciso recarregar a extensão depois de instalar (o ping tem cache de 15 s)" (Emenda 10) só valiam sem Port aberto.

**Correção** (`src/background/sink-host.ts`): o Port ocioso fecha sozinho. Quando um pedido responde (ou passa do tempo) e nenhum outro está pendente, arma `IDLE_RELEASE_MS` (30 s, acima do cache de 15 s do ping e do intervalo de 2 s do popup); ao disparar, chama `releaseHost()` só se a condição registrada pelo `sessions.ts` (`keepHostWhile(hasRecording)`: alguma gravação com status `gravando`) for falsa. O `releaseHost` já recusa com pedido pendente, então um pedido novo não precisa cancelar o fechamento (a resposta dele arma de novo). Resultado: um perfil ocioso passa para o helper instalado até 30 s depois de fechar a última tela; uma gravação em andamento nunca troca de processo no meio e termina com o de antes, e a seguinte já abre o novo. O helper não sai sozinho depois de responder (proposta descartada): ele não sabe se o SW vai gravar logo em seguida, e sair entre o ping e o `begin` sujaria justamente a primeira call depois de instalar. Gancho de teste `hostIdleMs(ms)` (só os testes de ponta a ponta). Esta seção substitui as duas frases citadas acima; a do `instalar.mjs` foi reescrita.

Efeito colateral esperado: o SW dos perfis que abriam o popup volta a dormir como o MV3 prevê (o código foi desenhado para isso desde a Emenda 10). Cada popup aberto depois de 30 s ocioso sobe um node novo, que roda o `resumeTranscriptionQueue` (idempotente, com trava).

### E. A repetição do whisper e o trecho sem falante

Investigação com o whisper-cli 1.9.2, o large-v3-turbo e o áudio da daily (a linha de base reproduz a transcrição original: 355 segmentos brutos, 350 depois do `dropInventedSegments`). Os argumentos do whisper ficam como estão:
- `-et 2.8`, `-nf` e `-nth 0.3` saem byte a byte iguais (o fallback de temperatura nunca dispara);
- `--suppress-nst` só tira uma cópia e perde uma palavra real;
- `-lpt -0.5` troca o laço por lixo e é cerca de 1,5 vez mais lento;
- `-bs 1` e `-bs 8 -bo 8` pioram (o segundo cria um "bom" repetido 13 vezes);
- `-mc 64` perde 101 palavras;
- `-mc 0` (sem contexto) tira toda repetição, dá frases inteiras com pontuação e é o mais rápido, mas erra mais conteúdo (em 56 trechos que divergem, a base acerta mais em 13 e ele em 2: termos técnicos e nomes). Fica para decidir com mais 2 ou 3 calls reais.

**`collapseRepeats(segments, pauses)`** (`host/transcricao.mjs`, `REPEATS`), entre o `dropInventedSegments` e o `assignSpeakers`. Compara ignorando maiúsculas, acentos e pontuação:
1. dentro de um segmento, uma frase de 2 ou mais palavras repetida 3 ou mais vezes seguidas, ou uma palavra 4 ou mais, fica uma (o período mais curto primeiro);
2. um segmento com o mesmo texto do anterior mantido fica um só, o que tem mais fala fora dos silêncios do ffmpeg (empate: o primeiro); com 1 ou 2 palavras ("Tchau", "Bom dia"), só quando uma das cópias está mais da metade em silêncio, porque podem ser duas pessoas;
3. um segmento de 3 ou mais palavras igual a um dos 3 anteriores mantidos, começando até 10 s depois do fim dele, sai (o laço "A / B / C / A / A / A").

Na daily: de 350 para 344 segmentos, saem 24 palavras, todas das cópias (uma LCS de palavras contra a saída de antes dá 1267 de 1267 iguais e nenhuma acrescentada), em cerca de 1,5 ms. Falsos positivos possíveis: alguém que repete de propósito a mesma frase de 3 ou mais palavras dentro de 10 s (ela fica uma vez), duas pessoas dizendo a mesma frase longa uma atrás da outra. O colapso não recupera o que o laço cobriu. A causa estrutural é a fala do próprio usuário, que vira um buraco no áudio: o laço e a cópia nasceram na borda de um silêncio de 26,4 s em que ele falava. O VAD do whisper (`--vad`) não foi medido: falta o modelo `ggml-silero` na máquina, e baixar exige permissão do usuário.

**`fillSpeakerGaps`**: um trecho sem falante (cai num buraco curto da linha do tempo) herda o falante só quando o trecho de antes e o de depois, a até 1 s (`NEIGHBOR_GAP_SEC`), têm o mesmo. O "mais próximo" errou o único caso real medido (deu a quem tinha 0,25 s ali; a frase era de quem falava antes e depois). Amostra de 1 caso, declarada.

### F. Transcrever de novo uma gravação já salva

`npm run transcrever -- "<pasta da call>"` (`scripts/transcrever-de-novo.mjs`): põe a pasta de novo na fila com `enqueueTranscription(..., { redo: true })` (uma `pronta` entra também) e roda o worker deste repositório (`host/transcrever.mjs`) com a configuração do helper (`GRAVADOR_CONFIG` ou a padrão). Troca o `transcricao.md` e o `.srt`; o áudio, o `falantes.json` e o resto do `info.json` ficam. Se o worker do helper já estiver rodando, a trava manda e este sai. Um botão "Transcrever de novo" no popup continua não feito.

### Replay da daily real (no rascunho, nunca na pasta real)

Cópia da pasta, worker de verdade (whisper-cli 1.9.2, large-v3-turbo, idioma automático), comparando com o `transcricao.md` e o `.srt` originais (as pessoas por letra, na ordem da primeira fala na transcrição nova; não são as letras da fixture):

| | antes (0.4.1) | depois (0.4.2) |
|---|---|---|
| segmentos | 350 | 344 |
| palavras | 1291 | 1267 |
| "Participante 1" | 330 | 0 |
| sem falante | 3 | 0 |
| Pessoa A / B / C / D / E / F | 2 / 2 / 0 / 0 / 5 / 8 | 3 / 22 / 112 / 105 / 70 / 32 |
| segmento igual ao anterior | 5 | 0 |
| igual a um dos 3 anteriores (até 10 s) | 5 | 0 |
| a frase do laço no `.md` | 5 vezes | 1 |
| tempo do worker | 15,5 s | 15,9 s |

O mesmo resultado sai pelo `npm run transcrever` numa segunda cópia com o `info.json` ainda em `pronta`.

### Testes

Unidade (cada um conferido vermelho com a mutação indicada e verde de volta):
- `meet-speakers.test.ts`: o 42 no mesmo pacote da Ana não vira falante (sem o filtro, aparece a chave `csrc:42`); o diagnóstico com o 42 no mesmo pacote, o próprio como `roster`, sem nenhum nome (sem o `rtpTimestamp` ou sem o receptor na conta do mesmo pacote).
- `src/shared/speakers.test.ts`, com a fixture anonimizada: a fonte sem nome sai, as 6 pessoas e você ficam, com o `descartadas` exato; as medidas das pessoas reais longe dos limiares; pessoa sem nome que fala sozinha (e vira "Participante 1"), duas que às vezes falam juntas, interjeições por cima de 3 pessoas, quem fala muito com a nomeada por cima, a call de duas pessoas, a chave resolvida e o arquivo igual ao de antes sem fonte sem nome; o diagnóstico guardado e escrito (sem a cobertura, sem a presença, 3 pessoas no lugar da presença, sem tirar a fonte, a chave resolvida contando como sem nome, o SW sem guardar o diagnóstico).
- `transcricao-falantes.test.ts`: o mesmo no helper, com o rótulo antigo, com `semNome` e em inglês, os trechos com os nomes certos (40 de 41: num deles a fala de uma pessoa cabe inteira na de outra, e o empate vai para o intervalo mais longo), e o worker de verdade com o log da fonte descartada (sem tirar a fonte, sem o rótulo antigo, sem o `semNome`, sem a cobertura, sem a presença).
- `meet-signals.test.ts` e `meet.test.ts`: o campo 7 pelo valor (`has()` no lugar da leitura tolerante), o registro do space dos blocos com a conta em duas calls (`self()` sem o space do DOM), o nome pela roster sem o marcador, o rótulo do bloco lido antes da roster (sem tirar o rótulo), o nome completo antes do exibido, a roster valendo mais que o DOM, a reserva no DOM; o `tituloSinais` com o formato `Meet: <código>`, o mais forte que fica (sem a força) e o seletor antigo.
- `sessions.test.ts`: o próprio nome que chegou depois sai dos participantes juntados, `voceSinais` e `tituloSinais` no `info.json` (sem filtrar, sem o `tituloSinais`), o diagnóstico pelo zod de verdade sem a chave a mais (com `passthrough`), e a condição do Port ocioso verdadeira só gravando (sem registrar).
- `session.test.ts`: o diagnóstico só no lote final (diagnóstico em todo lote).
- `sink-host.test.ts` (novo): fecha 30 s depois da última resposta e o pedido seguinte abre outro Port; não fecha gravando; pedido pendente segura; pedidos a cada 2 s adiam; pedido que passou do tempo também arma (sem rearmar na resposta, ignorando a gravação, sem armar no tempo esgotado).
- `transcricao-repeticao.test.ts` (novo), com os tempos e as pausas da daily e textos de placeholder: o laço vira A, B, C e a cópia de D com fala; "Tchau" e "Bom dia" ficam; o laço dentro do segmento; a herança entre vizinhos iguais; o worker com as pausas do ffmpeg falso e com o `falantes.json` (sem a regra 3, sem a escolha pela fala, sem a guarda de 1 ou 2 palavras, sem o colapso de dentro, o worker sem o colapso, sem conferir o vizinho seguinte, sem a distância, o worker sem a herança).
- `transcrever-de-novo.test.ts` (novo): uma pasta `pronta` com "Participante 1" sai com os nomes, e o áudio e o `falantes.json` ficam (sem o `redo`).
- `registry-falantes.test.ts`: o número do receptor estável entre leituras.

Ponta a ponta:
- `tests/e2e/helper-trocado.spec.ts` (novo), com o native messaging de verdade e o helper trocado no disco por um que responde 9.9.9: com o popup aberto e fechado, o processo antigo sai e o popup seguinte mostra a versão nova; no meio de uma call do Meet, o processo continua o mesmo por 8 s com a espera encurtada para 1,5 s, o `info.json` sai com a versão de antes, sem lacunas, e depois o popup mostra a nova. Conferidos vermelhos no build: sem fechar por ociosidade (o processo antigo continua vivo) e ignorando a gravação (o Port fecha no meio da call).
- `tests/e2e/falantes.spec.ts`: o teste do Meet com o bloco do próprio usuário sem o `[data-self-name]` (a variante `falantes` com `marca=nao`, como na call real): `voce` pela roster, fora dos participantes, `voceSinais` e `tituloSinais` no `info.json`, e o `falantes.json` sem `descartadas` nem `diagnostico` (não há CSRC numa conexão direta). Conferido vermelho no build sem a roster no `readMeta`.

### Não feito, ou para conferir na próxima call real

- O 42 confirmado no cliente web do Meet: o `diagnostico.csrc` da próxima call deve mostrar o 42 com muitas leituras, `resolvida: false` e `mesmoPacoteComNomeada` perto das leituras dele.
- O campo 7 no registro do próprio usuário: o `voceSinais.roster` da próxima call diz se veio.
- O título: a conferência visual de 5 s descrita em C, com o `tituloSinais`.
- O helper trocando sozinho num perfil de verdade: depois de instalar a 0.4.2, abrir o popup, fechar, esperar 30 s; o `pgrep -lf gravador-host.mjs` não deve listar processo de perfil ocioso, e o `helper` do `info.json` da próxima call deve ser 0.4.2. Os processos da 0.4.1 e de antes que já estão abertos só fecham com o "Recarregar agora" da extensão (ou o Chrome fechando).
- Usar o 42 para dizer quem é o principal numa sobreposição (o CSRC no mesmo pacote dele): exige guardar o receptor na linha do tempo; fica para quando o diagnóstico confirmar.
- O diagnóstico de CSRC no Teams.
- `-mc 0` e o VAD do whisper, a medir com mais calls.
- O cabeçalho do `transcricao.md` de uma gravação de antes, transcrita de novo, continua com o próprio usuário nos participantes: vem do `info.json` daquela gravação.

O contrato que nenhuma parte muda sozinha passa a incluir `SpeakerDiagnostics` e o `diagnostico` do `session:speakers` e do `SpeakersFile`, `SpeakerDropped` e `SpeakersFile.descartadas`, `semNome` em `InfoSpeakers.pessoas`, `CallMeta.selfSignals` e `CallMeta.titleSignals`, `InfoJson.voceSinais` e `InfoJson.tituloSinais`, `ContributingSource.receiver`, o gancho `speakerDiagnostics` do adaptador, `MEET_LOUDEST_SPEAKER_CSRC`, `UNNAMED_SHADOW` (os mesmos limiares nos dois lados), `REPEATS`, `NEIGHBOR_GAP_SEC`, `IDLE_RELEASE_MS`, `keepHostWhile` e o `redo` do `enqueueTranscription`.

## Emenda 21: transcrição por API dentro da extensão (13/10/2026, 0.5.0)

Pedido do usuário (13/10/2026): a transcrição automática exigia o helper local (whisper.cpp, ffmpeg, modelo de 1,5 GB, terminal). Quem instala pela Chrome Web Store não conseguia usar: a seção das configurações mostrava só o aviso "exige o helper local, ainda não distribuído pela loja". Ele quer um motor que use a API de transcrição de um provedor, com a chave dele, rodando DENTRO da extensão, para quem baixa da loja colar a chave e pronto.

Esta emenda **acrescenta**. O motor local do helper continua existindo, continua sendo o padrão e nada do comportamento dele muda: quem liga o motor por API naquele perfil é que passa a transcrever por aqui. Com o motor por API desligado (o padrão, e o de toda configuração guardada antes da 0.5.0), tudo sai exatamente como antes, e nenhuma requisição de rede é feita.

Isto é a seção 6 de `docs/LOJA.md` ("motor na nuvem, opcional, com a chave do próprio usuário"), que estava planejada e não feita.

### A. Onde roda, e o texto compartilhado

O motor roda na **extensão** (service worker, com o documento offscreen só para montar os Blobs de download). É isso que faz a transcrição funcionar para quem não tem helper.

O obstáculo era o texto: todas as regras de saída (parágrafos, falantes, markdown, SRT, colapso de repetição) viviam em `host/transcricao.mjs`, que importa `node:child_process`, `node:fs`, `node:os` e `node:path` e por isso o Vite não consegue incluir no bundle. As funções puras saíram para **`host/texto.mjs`**, com os tipos em `host/texto.d.mts`:

- `isObj`, `mdLine`, `LANGUAGE_RE`, `ENGINE_LABELS`, `MODEL_PREFERENCE`, `rankModel`, `errorLine`;
- `speechText`, `segmentsFromWhisperJson`, `silencesFromFfmpeg`, `dropInventedSegments`;
- `REPEATS`, `collapseInside`, `collapseRepeats`, `NEIGHBOR_GAP_SEC`, `fillSpeakerGaps`;
- `PARAGRAPH`, `pausedBetween`, `mergeSegments`, `formatClock`, `formatSrtTime`, `buildSrt`;
- `SPEAKERS_FILE`, `MIN_SELF_LINE_SEC`, `SELF_MAX_COVERED`, `cleanSpeakerName`, `mdName`, `srtName`;
- `UNNAMED_SHADOW`, `checkUnnamedSources`, `speakerTimelineFrom`, `assignSpeakers`, `selfLines`;
- `MARKDOWN_LABELS`, `markdownLanguage`, `platformLabel`, `formatDuration`, `formatLocalStart`, `buildMarkdown`;
- `transcriptionsOf`, `ORPHAN_GRACE_MS`, `reconcileTranscription`, `transcriptStem`.

**Formato, e por quê.** O helper roda em Node puro, sem build, a partir da cópia em `bin/` que o `host/instalar.mjs` faz; a extensão é TypeScript com Vite. Um arquivo `.mjs` ESM sem nenhum import serve aos dois: o Node o importa direto e o Vite o inclui no bundle. Os tipos vêm de um `.d.mts` ao lado, o mesmo arranjo de `scripts/build-info.mjs` + `scripts/build-info.d.mts` que o `vite.config.ts` já usava (precedente do repositório). A alternativa, escrever em TypeScript dentro de `src/` e compilar para o helper, criaria um passo de build para um programa que hoje não tem nenhum.

**O helper não fica com cópia:** `host/transcricao.mjs` importa e reexporta tudo, então o helper, os scripts e os testes continuam pedindo tudo a ele. `texto.mjs` entrou em `HOST_FILES` (`host/args.mjs`), senão a cópia instalada do helper não sobe. O `scripts/publicar.mjs` só copia o `dist/` (não toca o helper) e o `npm run empacotar` empacota o `dist/`, então **nenhum arquivo do helper entra no pacote da loja**: o `texto.mjs` chega lá dentro do bundle, como qualquer módulo de `src/`.

### B. Configuração por perfil, e a chave

Diferente da transcrição do helper, que é global (`config.json`, vale para todos os perfis), a deste motor é **por perfil do Chrome** (`Settings.apiTranscription`, `chrome.storage.local`): mandar o áudio da call para fora é decisão de cada empresa. Nasce **desligada**.

```ts
interface ApiTranscriptionConfig {
  ativa: boolean      // desligada por padrão
  provedor: string    // id de API_PROVIDERS
  endpoint: string    // vazio: o do provedor; só uma origem declarada é aceita
  modelo: string      // vazio: o do provedor
  idioma: string      // 'auto' ou pt, en...
}
```

A **chave** fica numa chave de armazenamento **própria** (`apiTranscriptionKey`), nunca dentro de `settings`: assim ela não passa pelo `ui:save-settings` (que manda o objeto inteiro), não vai para o `ui:state`, não entra no `info.json` e não aparece em nenhuma mensagem de erro. `src/shared/api-key.ts` é o único arquivo que a lê e a escreve, e quem escreve é a **página de configurações**, direto no `chrome.storage.local`, como o idioma desde a Emenda 19: a chave não passa por mensagem nenhuma ao service worker. Quem a lê é só o SW, no instante de montar o cabeçalho `Authorization`. As telas nunca a recebem: `apiKeyHint` devolve `••••` e os quatro últimos caracteres. O `apiTranscriptionSchema` é `strict()`, então um campo a mais que parecesse uma chave não passa.

**Provedores como dado** (`src/shared/api-transcription.ts`, `API_PROVIDERS`): `{ id, rotulo, endpoint, origem, modelo, chaveUrl, dolaresPorMinuto, maxBytes }`. Trocar de provedor é uma linha. Hoje só `openai`:

- `POST https://api.openai.com/v1/audio/transcriptions`, `multipart/form-data`, `Authorization: Bearer <chave>`;
- o nosso áudio é `audio/webm;codecs=opus`, que a API aceita direto: **não precisa de ffmpeg nem de conversão**;
- `whisper-1`, porque só ele devolve os tempos (`response_format=verbose_json` com `timestamp_granularities[]=segment`). O `gpt-4o-transcribe` e o `gpt-4o-mini-transcribe` são mais baratos e NÃO devolvem tempos, e sem tempos não dá para casar a fala com o `falantes.json` (Emenda 18) nem manter os nomes de quem falou;
- limite de 25 MB por requisição (a 32 kbps mono, cerca de 1 h 49 de call) e 0,006 dólar por minuto, conferidos na documentação oficial em 13/10/2026.

### C. A fila e a retenção do áudio (o ponto mais delicado)

Os pedaços do áudio saem do IndexedDB assim que a gravação é salva (`deleteChunks` em `sessions.ts`), e a extensão **não consegue ler de volta** o arquivo que o helper gravou no disco. Então, com o motor ligado, o `doFinalize` guarda o áudio **antes** do `deleteChunks`, na loja `apiAudio` do IndexedDB (`DB_VERSION` 2).

**Um Blob montado, não os pedaços soltos.** Os pedaços são de 5 s (`RECORDING_TIMESLICE_MS`), então uma call de 1 h tem cerca de 720 registros: cada tentativa de envio teria de ler e concatenar os 720 de novo, o `deleteChunks` do finalize teria de aprender a poupar uns e não outros, e o tamanho total (que a retenção e o limite de 25 MB precisam saber) só sairia somando tudo. Com um registro por gravação, a leitura é uma, o tamanho é `bytes`, e o `deleteChunks` continua como estava.

O registro é **autocontido** (`ApiAudioRecord`): leva o `info.json` e o `falantes.json` daquela gravação, então não depende do registro da sessão (que o `pruneOldRecords` pode apagar) nem de ler a pasta no disco.

**Retenção, com três limites nomeados** (`API_RETENTION`, os mesmos valores nos dois lados do teste):

| Limite | Valor | Ao estourar |
|---|---|---|
| `maxAttempts` | 5 tentativas | o áudio é apagado e a gravação fica com o motivo e a última falha |
| `maxAgeMs` | 24 h | o áudio é apagado com o motivo |
| `maxTotalBytes` | 300 MB somados | as mais antigas são apagadas até caber (a que acabou de ser gravada nunca é a que sai) |

`applyRetention` é pura e conta do mais novo para o mais antigo. **Nada fica guardado para sempre**, e nenhum limite apaga a gravação: só o áudio guardado a mais.

**Tentativas por `chrome.alarms`**, no padrão do `RECOVER_ALARM` de `sessions.ts`: o alarme `gravador:transcricao-api` existe enquanto há fila e sai quando ela esvazia. A espera cresce (15 s, 1 min, 5 min, 15 min; a última vale para as seguintes), guardada em `nextAt` de cada trabalho. A fila vive no IndexedDB, então um service worker que morre no meio não perde nada: o alarme o acorda e a passada decide de novo. Duas passadas ao mesmo tempo no mesmo SW não mandam o mesmo áudio duas vezes (uma promessa só).

**Erros, cada um do seu jeito** (`classifyApiError`, `retriesAlone`):

| Caso | Tipo | Repete? |
|---|---|---|
| 401, 403 | `config` | não (repetir não conserta; o áudio sai e a gravação fica com "o provedor recusou a chave") |
| 429 | `limite` | sim, com espera |
| 5xx | `servidor` | sim, com espera |
| sem resposta (rede, DNS, VPN) | `rede` | sim |
| 413, ou acima do limite antes de enviar | `grande` | não |
| 400, 404, 422... | `pedido` | não |

As mensagens saem no idioma da interface (Emenda 19), pelas chaves `apiErr*`, no mesmo molde dos motivos de `helper-reasons.ts`. O motivo do navegador para um erro de rede **não** entra na tela (ele pode levar a URL); o corpo de uma resposta de erro não é lido para texto (ele pode ecoar o que foi enviado).

**Áudio acima de 25 MB não é enviado nem cortado nesta versão:** a gravação fica com "a call é longa demais para a API (X MB, acima do limite de 25 MB): o motor local transcreve esta gravação". Cortar webm sem ffmpeg está **fora de escopo**, declarado.

**Nada é enviado** com o motor desligado, sem a chave, sem a permissão de host concedida, ou com um endereço que não seja de uma origem declarada. Sem a chave e sem a permissão o trabalho **espera na fila** com o motivo (como o motor local espera o whisper), e colar a chave depois transcreve as calls que esperavam.

### D. A saída, nos dois destinos

O resultado passa pelas **mesmas funções do helper** (`host/texto.mjs`): `collapseRepeats`, `assignSpeakers` com a linha do tempo daquela sessão, `fillSpeakerGaps`, `mergeSegments` e `buildMarkdown`. Então o `transcricao.md` sai com os nomes de quem falou, igual ao do motor local. O `dropInventedSegments` fica de fora: ele é o único passo que depende dos silêncios medidos pelo ffmpeg, que a API não devolve.

- **Salva pelo helper:** operação nova `transcription-write { path, audio, arquivos, transcricao }`. O helper confere que a pasta está dentro de uma raiz conhecida (caminho real, sem `..` nem symlink para fora) e que cada nome é `transcricao*.md` ou `.srt`, as mesmas guardas do `open-file`; escreve atômico e grava o estado em `info.json.transcricao` pelo mesmo `updateInfoTranscription` do worker local. O popup então mostra "Transcrição pronta" e "Abrir transcrição" sem saber quem transcreveu.
- **Salva em Downloads** (o caso de quem instala pela loja): os arquivos descem pelo `chrome.downloads` na mesma pasta da gravação, do jeito do `sink-downloads.ts` (Blob montado no offscreen, pelo pedido novo `offscreen:text-url`, porque `createObjectURL` não existe no SW), com `conflictAction: 'overwrite'` e o nome conferido depois (se o Chrome renomear, desfaz, para não deixar `transcricao (2).md`). O **`info.json` não é reescrito**: o `chrome.downloads` não sobrescreve um arquivo já baixado sem risco de virar `info (1).json`. O estado fica na extensão (`apiTranscriptionState`, em `chrome.storage.local`, as 20 últimas) e o popup o mostra do mesmo jeito. Declarado como limitação.
- **"Abrir transcrição" sem helper** mostra o arquivo no Finder (`chrome.downloads.show`): abrir com o aplicativo padrão exigiria a permissão `downloads.open`, que não vale o escopo.

**Os dois motores nunca escrevem a mesma pasta.** Com o motor por API ligado, o `finalize` manda `semTranscricao: true` e o helper não põe a pasta na fila do motor local. Um helper anterior ignoraria o campo, então, com um helper **instalado** em versão menor que **0.5.0**, o motor por API **recusa** a gravação com "o helper instalado é de uma versão anterior à 0.5.0 e transcreveria a mesma call no motor local: rode npm run instalar de novo". Sem helper nenhum (o caso da loja), funciona sempre.

### E. Permissão de host

`optional_host_permissions: ['https://api.openai.com/*']`, nos dois builds. **Nada de `https://*/*`**: a lista sai de `API_PROVIDERS`. A permissão é pedida com `chrome.permissions.request` no clique em que o usuário liga o motor (o Chrome só aceita num gesto), e a recusa vira uma mensagem clara, com o motor ficando desligado. O SW confere com `chrome.permissions.contains` antes de cada envio.

O **endereço** é validado por origem (`originPatternOf`): só uma das origens declaradas passa, o que já implica https fora dos testes. No **build de desenvolvimento** entra também `http://127.0.0.1/*`, o servidor falso dos testes, em `host_permissions` (não em `optional_host_permissions`): medido no Chrome for Testing headless em 13/10/2026, o `chrome.permissions.request` de uma permissão de host **nunca resolve** sem o diálogo do Chrome, e não há ninguém para clicar. O pacote da loja não leva essa origem, nem no manifesto nem na lista de endereços aceitos.

### F. Interface

A seção "Transcrição" das configurações passa a existir **com e sem o helper**, com a escolha do motor em dois rádios:

- **"O seu computador (whisper.cpp)"**, o padrão: o formulário de sempre. Sem o helper, a frase de que ele é necessário fica aqui dentro (antes ela morava em "Avançado").
- **"A API da OpenAI, com a sua chave"**: funciona sem instalar nada.

O **aviso de privacidade aparece ANTES de ligar**, em âmbar, dizendo que o áudio da call, com a voz dos participantes, é enviado para o servidor do provedor, que a chave fica só nesta máquina, e que gravar e transcrever exige o consentimento de quem participa. A frase "Nada sai do computador" (`trAutoHint`) passou a falar só do motor local ("Com este motor, nada sai do computador"), e cada motor tem a sua frase. A tela diz, em uma linha, **quanto custa por hora de call** e qual é o limite de tamanho, e tem o link para criar a chave.

O campo da chave é `type=password`, com "Guardar a chave" e "Apagar a chave"; depois de guardada, a tela mostra só `••••` e os quatro últimos caracteres. Apagar a chave desliga o motor (sem chave nada seria enviado, e a tela não pode mentir). O endereço fica em "Endereço da API", recolhido. "Avançado" ficou com a pasta e o helper. Nada mais da página mudou.

No **popup**, o estado daquela gravação vale mais que a regra do destino: uma gravação em Downloads transcrita pela API mostra "Transcrição pronta" em vez de "Sem transcrição: ela precisa do helper local", e o aviso do rodapé sobre o motor local não aparece quando quem transcreve é a API.

### Testes

Unidade (cada um conferido vermelho com a mutação indicada e verde de volta):

- `tests/unit/texto-compartilhado.test.ts` (novo): nada de `node:*`, DOM nem `chrome.*` no arquivo compartilhado; o helper reexporta as mesmas funções (a mesma identidade, não uma cópia igual) e não redeclara nenhuma; `texto.mjs` em `HOST_FILES`.
- `src/shared/api-transcription.test.ts` (novo): a configuração nasce desligada e por perfil; `strict()` recusa um campo a mais; a seção ausente (antes da 0.5.0) e um campo inválido voltam ao padrão sem derrubar os outros; a origem (http de fora, outro esquema, `api.openai.com.mau.example`, lixo); a loja só com https e o loopback só no desenvolvimento; a chave só no cabeçalho `Authorization` (nem na URL, nem no multipart, nem em query string) e a dica sem a chave inteira; os três limites da retenção, um caso cada; a espera crescente; a classificação de 401, 403, 429, 5xx, rede, 413 e 400 com `retriesAlone`; a leitura do `verbose_json` e o custo por hora.
- `src/background/api-transcription.test.ts` (novo), com o IndexedDB, o `chrome.*` e o `fetch` falsos: nada enviado com o motor desligado, sem a chave, sem a permissão de host, nem com o helper antigo; um endereço de outra origem guardado à mão nunca é usado; acima de 25 MB não entra na fila; a chave só no cabeçalho e em nenhum arquivo nem estado; o multipart; o `transcricao.md` com os nomes de quem falou e sem eles; o registro no `info.json` no formato do helper; 401 sem repetir e apagando o áudio; 429 e 5xx repetindo com espera crescente e a hora respeitada; rede sem o motivo do navegador na tela; 400 sem repetir; a saída que falha guardando o áudio; cada limite da retenção; a fila sobrevivendo ao módulo ser recarregado (o SW morrendo) e o alarme saindo com a fila vazia; três passadas ao mesmo tempo mandando uma vez.
- `src/background/sessions.test.ts`: com o motor desligado o `finalize` não manda `semTranscricao` e nada é guardado; ligado, manda, e o áudio é guardado ANTES do `deleteChunks` (o teste conta os chunks no instante da chamada); sem helper, o mesmo com `sink: 'downloads'`; uma gravação descartada por ser curta não guarda nada.
- `tests/unit/gravador-host.test.ts`: o `transcription-write` escreve os arquivos e grava o estado no `info.json` (e o `open-file` abre o `.md`); `semTranscricao` deixando a fila local vazia; recusa de um nome que não é da transcrição, de `../fora.md`, de uma pasta fora da raiz e da pasta irmã `<raiz> outra`, de um texto acima de 8 MB e de um áudio com nome inválido, sem deixar nada na pasta; sem arquivos, só o estado (é assim que uma falha é registrada).
- `src/background/transcription.test.ts` e `src/popup/format.test.ts`: sem helper e com o motor ligado o estado vem da extensão (antes era `null`); sem os dois, continua `null`; com helper, o estado da extensão vale mais; "Abrir transcrição" de uma gravação em Downloads mostra o arquivo no Finder; a linha da gravação e o aviso do rodapé.
- `tests/unit/pacote-loja.test.ts`: a permissão opcional é só `api.openai.com` na loja, sem curinga e só https; o loopback dos testes em `host_permissions` do desenvolvimento e em nenhum lugar da loja; `docs/LOJA.md` justifica a origem.
- `tests/unit/instalar.test.ts`: o `texto.mjs` copiado na instalação e ausente quando a instalação é na própria pasta do repositório.

Ponta a ponta, `tests/e2e/transcricao-api.spec.ts` (novo), no Chrome for Testing, **sem helper**, com downloads de verdade e um **servidor HTTP falso no loopback** no lugar da API (nunca a API de verdade, nunca uma chave de verdade: a chave é um literal do arquivo de teste). A call falsa do Meet é a de `falantes.spec.ts` (roster pelo `collections`, quem fala pelo `dcrpc`), e o motor é ligado **pela tela**: o aviso de privacidade antes de ligar, o custo, o limite, ligar sem a chave que não liga, o endereço do servidor falso, a chave guardada que aparece só como `••••0000`, e o rádio do motor.

- a call é transcrita: `transcricao.md` e `transcricao.srt` na pasta da call em Downloads, com as quatro linhas na ordem e os nomes certos (inclusive a linha "Você: (sua fala não é gravada)"), o cabeçalho com "OpenAI API, modelo whisper-1, idioma portuguese", uma requisição só com `Authorization: Bearer <chave falsa>` e o áudio no multipart, o popup mostrando "Transcrição pronta" sem falar do helper, o áudio guardado apagado depois, e a chave em nenhum arquivo da pasta;
- 401 não repete, apaga o áudio guardado e o popup mostra "o provedor recusou a chave da API";
- 429 deixa a gravação esperando com o motivo e a tentativa seguinte transcreve;
- o service worker derrubado pelo CDP no meio da fila: o SW novo vê a fila do IndexedDB e termina o trabalho;
- com o motor desligado, nada é enviado e a pasta sai sem transcrição.

### Não feito, ou para conferir com o uso real

- **Nenhuma requisição foi feita à API de verdade.** Todos os testes usam um servidor falso no loopback. O formato da resposta (`verbose_json` com `segments`) vem da documentação oficial de 13/10/2026, não de uma chamada deste projeto: **o usuário precisa transcrever uma call de verdade com a chave dele** para confirmar o formato, o custo e a qualidade do texto.
- Cortar uma call acima de 25 MB em pedaços para enviar (sem ffmpeg, no navegador).
- Outro provedor em `API_PROVIDERS` (hoje é uma linha, mas nenhum outro foi medido).
- Motor no navegador (Whisper em WebGPU no offscreen), que continua na seção 5 de `docs/LOJA.md`.
- Transcrever de novo pelo popup uma gravação que falhou (continua sendo corrigir a configuração e `npm run transcrever`, que só serve ao motor local).
- O `info.json` de uma gravação em Downloads não recebe o estado da transcrição (ver a seção D).
- A permissão de host da API não é exercitada no ponta a ponta (o diálogo do Chrome não existe no headless): quem a cobre é o teste de unidade da fila.
- O site **não** foi publicado de novo e nada foi enviado para a loja. A política de privacidade (seção 7-A nas duas línguas) e a divulgação de dados (`docs/loja/`) já estão escritas; publicar e reenviar fica com o usuário.

O contrato que nenhuma parte muda sozinha passa a incluir `host/texto.mjs` (as funções acima, iguais nos dois lados), `Settings.apiTranscription` (`ApiTranscriptionConfig`), `API_KEY_STORAGE_KEY` e `API_TRANSCRIPTION_STATE_KEY`, `API_PROVIDERS` e `API_ENGINE_ID`, `API_RETENTION`, `classifyApiError`/`retriesAlone`, `ApiAudioRecord` e a loja `apiAudio` (`DB_VERSION` 2), a operação `transcription-write` e o `semTranscricao` do `finalize`, o pedido `offscreen:text-url`, `RecentTranscription.downloadId`, `TranscriptionUiState.motor`, `HOST_MIN_FOR_API` e as chaves `tr*` e `apiErr*` novas.

## Emenda 22: escolher o motor que não se mexia, e o passo a passo do motor local (13/10/2026, 0.5.1)

Pedido do usuário (13/10/2026): "também não to conseguindo selecionar o A API da OpenAI, com a sua chave" e, na mesma mensagem, mostrar na opção "O seu computador" um acordeão com todo o passo a passo do que precisa ser instalado e o prompt para colar no Claude Code, para ele instalar tudo e conectar com a extensão.

Esta emenda **acrescenta e corrige a interface**. Nada do comportamento de envio muda: as quatro portas da Emenda 21 (motor desligado, sem chave, sem permissão de host, endereço fora de uma origem declarada) continuam exatamente como estavam, e os testes delas (`src/background/api-transcription.test.ts` e `tests/e2e/transcricao-api.spec.ts`) seguem passando sem mudança de comportamento. O helper não mudou, então `HOST_VERSION` fica em **0.5.0** e ninguém precisa rodar `npm run instalar` de novo.

### A. O defeito: o rádio significava duas coisas

Em `src/options/Options.tsx`, o rádio `data-testid="motor-api"` era `checked={cfg.ativa}` e o `onChange` chamava `enableApi()`, que na primeira linha fazia `if (!keyHint) return setMessage(trApiKeyMissing)`. Sem chave guardada, `cfg.ativa` nunca virava true, o React devolvia o rádio para "O seu computador" e a única pista era um parágrafo (`transcricao-api-mensagem`) no fim da seção, depois do acordeão do endereço. O usuário clicava, nada se movia perto do clique, e ele concluía que o rádio estava quebrado.

A causa é o rádio carregar dois significados ao mesmo tempo: "o que eu quero configurar" e "o que está ativo".

### B. A separação

- **Painel escolhido** (`EnginePanel`, estado de tela em `TranscriptionSection`): o clique **sempre** o muda, na hora, sem depender de chave, de permissão nem do helper. Clicar nunca mais "não faz nada". Vai no DOM como `data-painel` do `transcricao-motor`.
- **Motor realmente ativo**: continua sendo `Settings.apiTranscription.ativa`, e só vira true com a chave guardada **e** a permissão de host concedida. Continua no `data-motor`, com o mesmo significado de antes.
- Ao abrir, o painel começa no motor ativo (`panelOfActiveEngine`).
- Escolher o painel da API quando ela **não está pronta** não liga nada e não salva `ativa: true` (o teste confere o storage). Quando a chave já existe, o clique tenta ligar, como antes, porque o `chrome.permissions.request` precisa do gesto do usuário e este é o gesto.
- Escolher o painel do computador **desliga** o motor por API, como antes: é uma escolha explícita de não mandar áudio para fora.

### C. Situação visível junto da opção

`src/shared/transcription-engine.ts`: `engineSituation(panel, api, local)` é pura e devolve `{ kind, tone, key, subs, action, actionKey, actionSubs }`. A tela a mostra **debaixo da opção escolhida**, dentro do `fieldset`, com o botão que resolve ao lado (`motor-situacao` e `motor-situacao-acao`). A ação, nos dois casos em que existe, é a mesma função `enableApi()`: pede a permissão (uma já concedida resolve na hora, sem diálogo) e salva `ativa: true`.

| `kind` | Quando | Frase | Botão |
|---|---|---|---|
| `api-sem-chave` | sem chave guardada | `trApiKeyMissing` | nenhum (o campo da chave está logo abaixo) |
| `api-sem-permissao` | com chave, `permissions.contains` false | `trSitApiNoPermission` | `trSitGrant` |
| `api-ligado` | `ativa` com chave e permissão | `trApiReady` | nenhum |
| `api-desligado` | pronto e desligado | `trApiOff` | `trSitTurnOn` |
| `local-verificando` | helper ou `transcription-status` sem resposta | `helperChecking` | nenhum |
| `local-sem-helper` | sem helper (ou instalado e sem abrir) | `trSitLocalNoHelper` | nenhum |
| `local-pronto` | helper com o motor disponível | `trSitLocalReady` (o modelo achado) | nenhum |
| `local-sem-motor` | helper sem whisper, ffmpeg ou modelo | `trSitLocalMissing` (o motivo do helper) | nenhum |

Duas decisões dentro da regra, cada uma com teste:
- a **permissão é conferida antes do `ativa`**: uma permissão revogada em `chrome://extensions` deixa `ativa: true` no storage, o SW não envia nada (porta da Emenda 21) e a tela não pode dizer que está ligado;
- `temPermissao`/`disponivel` em `null` significa "ainda não sei" e **não acusa nada**, para a tela não piscar um aviso errado.

Nenhum tom é âmbar nem vermelho (`EngineTone` é `ok`, `acao` ou `neutro`): o que falta instalar é o uso normal de quem baixou da loja, não um erro (Emenda 15). O único alerta da seção continua sendo o aviso de privacidade do motor por API, e `tests/e2e/interface.spec.ts` cobra que não haja outro.

### D. Cada painel mostra só o que é dele

Antes, a chave, o custo, o aviso de privacidade, o idioma e o endereço apareciam mesmo com o computador escolhido, e a seção do helper aparecia mesmo com a API escolhida. Agora o painel da API (`painel-api`) leva o aviso de privacidade, o custo, o limite, a chave, o idioma e o endereço, e o painel do computador (`painel-local`) leva o acordeão do passo a passo e o formulário do motor local. O aviso de privacidade continua aparecendo **antes de ligar**, dentro do painel da API: ele é a razão de a escolha existir.

A leitura do `ui:transcription` subiu para `TranscriptionSection`, porque a linha da situação precisa do que o helper achou; `LocalTranscriptionSection` recebe `state`, `loadError` e `onReload` e refaz o formulário quando a leitura muda. A página continua sem falar com o SW em laço: uma leitura ao abrir e uma por ação.

### E. O passo a passo e o prompt, de uma fonte só

`src/shared/instalar-local.ts` é a fonte única. `INSTALL_STEPS` é um array de seis passos com `labelKey` (o rótulo em linguagem de quem não é técnico, o mesmo na tela e no prompt), `checkKey` (o que conferir antes do passo seguinte, só no prompt) e `commands` (dados, iguais nas duas línguas). Precedente da constante com `labelKey`: `TRANSCRIPTION_LANGUAGES` e `UI_LANGUAGE_OPTIONS` em `src/options/form.ts`.

`installPrompt(locale)` é pura e monta o texto com `tIn`, então o prompt sai no idioma da interface (Emenda 19) nas duas línguas; `currentMessageLocale()` (novo em `i18n.ts`) traduz o `auto` para a pasta de `public/_locales` que vale. O prompt é texto puro, **sem cerca de código** (os três acentos graves do markdown), porque o documento e o site o embrulham num bloco e um bloco dentro do outro não fecha; os comandos vão indentados, um por linha.

Quatro destinos, a mesma fonte:
- a tela, no acordeão `passo-a-passo` (um `<details>` fechado por padrão, precedente dos acordeões "Avançado" e "Endereço da API" no mesmo arquivo), com a lista dos passos, o aviso de que o instalador existe só para macOS (`chrome.runtime.getPlatformInfo().os !== 'mac'`, nunca string de navegador), o prompt num `<pre>` selecionável com o botão **Copiar** (`navigator.clipboard.writeText` em try/catch; falhando, o texto do bloco é selecionado e a tela diz para copiar com o atalho) e o link do repositório público;
- `docs/PROMPT-INSTALAR.md`, com os dois idiomas (português primeiro), gerado por `npm run prompt`;
- a seção "Transcrever no seu computador" do site, nas duas línguas (`site/index.html` e `site/en/index.html`), entre as marcas `<!--prompt-instalar:inicio-->` e `<!--prompt-instalar:fim-->`, escapada para HTML;
- `tests/unit/prompt-instalar.test.ts` é o portão: mudar um passo no código e esquecer o documento ou o site deixa a suíte vermelha. Ele também é o gerador (`ATUALIZAR_PROMPT=1`, que é o que `npm run prompt` faz), porque o Node não importa o `src/` em TypeScript com o import de JSON das mensagens, e o `vitest` já importa.

**Os fatos do prompt**, conferidos em 13/10/2026 e escritos como constantes: o instalador existe só para macOS; Node 22 ou mais novo (`brew install node`), `whisper-cli` (`brew install whisper-cpp`, a fórmula que entrega `/opt/homebrew/bin/whisper-cli`) e `ffmpeg` (`brew install ffmpeg`); `git clone https://github.com/jefersonftlopes/gravador-de-calls.git ~/Documents/gravador-de-calls`; **não rodar `npm install`** (o helper, o worker e `scripts/teste-transcricao-real.mjs` importam só `node:*` e caminhos relativos, e `npm run` funciona sem `node_modules`: poupa centenas de MB); o modelo `ggml-large-v3-turbo.bin` (1.624.555.275 bytes, cerca de 1,6 GB) em `~/Library/Application Support/gravador-de-calls/modelos/`, com o tamanho conferido no fim, porque um arquivo cortado faz o whisper falhar sem explicar a causa; `npm run instalar -- --id kpbjnbedejcbakdjacjmhaofidooddjp` (o ID da extensão da loja; sem ele a cópia da loja não acha o helper); e a prova final `npm run teste:transcricao-real`. O prompt pede ao Claude Code: conferir cada passo antes do seguinte, avisar antes do download grande, parar e explicar em linguagem simples quando falhar, nunca apagar arquivo do usuário nem mexer nas gravações, e parar e dizer o comando quando precisar da senha em vez de pedir a senha. No fim ele diz os dois passos que ficam com a pessoa, na própria extensão: escolher a pasta das gravações e deixar "O seu computador" escolhido.

**O passo a passo aparece também no pacote da loja**, de propósito: quem instala pela loja é justamente quem precisa dele, e o prompt começa clonando o projeto. `tests/e2e/pacote-loja.spec.ts` passou a cobrar que esse acordeão é o **único** lugar da página com `npm run` no build da loja (o `HelperInstall`, que supõe a pasta do projeto, continua de fora).

### F. Aviso do Vite sobre import sem extensão

`manifest.config.ts` importa `src/shared/api-transcription.ts`, que importa `./constants`, que importa `./protocol`. O carregador nativo de configuração do Vite exige a extensão no caminho que ele mesmo carrega, e avisava nos dois. Medido no repositório: dentro de `src/` não há **nenhum** import com extensão (são 492 sem), e os únicos arquivos que já usavam `.ts` eram `manifest.config.ts` e `vite.config.ts`, pela mesma razão. Decisão declarada: a extensão entra **só nesses dois imports**, com o comentário do porquê em cada um, e nada de troca em massa que o padrão do repositório não sustenta. Conferido: o aviso sai do `npm run build:only` e volta quando a extensão é removida.

### Testes

Unidade (cada um conferido vermelho com a mutação indicada e verde de volta):
- `src/shared/transcription-engine.test.ts` (novo): o painel de abertura; os quatro estados da API, incluindo "sem chave vale mesmo com `ativa` guardado" e "permissão revogada vale mais que o `ativa`"; os quatro do local; `null` não acusando nada; nenhum tom âmbar ou vermelho; e o mesmo estado dando situações diferentes nos dois painéis. Mutações: sem a conferência da chave (2 vermelhos), permissão conferida depois do `ativa` (1 vermelho).
- `src/shared/instalar-local.test.ts` (novo): toda chave de rótulo e de conferência existe nas duas línguas; a ordem e os comandos dos seis passos; nenhum `$n` sobrando; o tamanho do modelo no formato de cada idioma e num idioma que o Intl não conhece; `installerAvailableOn`; e o prompt, nas duas línguas, com o id da loja, o endereço do repositório, o `git clone`, o endereço e o tamanho exato do modelo, a proibição do `npm install`, a prova final, os três `brew install`, a pasta dos modelos e o tamanho em linguagem humana, além de cada comando numa linha indentada e sem cerca de código. Mutações: `installerAvailableOn` sempre true, `brew install whisper-cpp` trocado.
- `tests/unit/prompt-instalar.test.ts` (novo): `docs/PROMPT-INSTALAR.md` é exatamente o que os passos geram, com um bloco por língua na ordem que a spec de ponta a ponta lê; cada página do site traz o prompt da língua dela escapado para HTML; e o do site é o mesmo do documento. Mutação: um comando mudado sem regerar (5 vermelhos no documento e no site, mais 2 no prompt).

Ponta a ponta, `tests/e2e/motor-passo-a-passo.spec.ts` (novo), **sem helper** (o cenário da loja) e sem requisição de rede nenhuma: o defeito relatado (escolher a API sem chave marca o rádio, troca o painel, mostra "Cole a chave da API antes de ligar" dentro do `fieldset` e não salva `ativa: true` no storage); cada painel mostrando só o que é dele; o acordeão fechado por padrão, com um item por passo, o tamanho do download, o prompt igual ao de `docs/PROMPT-INSTALAR.md` letra por letra e o link do repositório; o botão Copiar confirmando (e, quando o Chrome deixa ler a área de transferência, o texto copiado sendo o prompt); o aviso de macOS ausente neste Mac e presente com `getPlatformInfo` respondendo `win` (por `addInitScript`); o prompt trocando de idioma na hora com English e voltando no Automático; a situação sem helper mandando para o passo a passo sem nada âmbar ou vermelho na página; e escolher o computador desligando o motor por API no storage, além da chave apagada voltando a situação para "sem chave". Mutações conferidas vermelhas: o rádio de volta a `checked={cfg.ativa}` com o `onChange` da 0.5.0 (3 vermelhos, inclusive o do defeito relatado), escolher o computador sem desligar a API, o acordeão com `open`, os dois painéis sempre na tela e `currentMessageLocale` ignorando o idioma escolhido.

O texto esperado do prompt na spec de ponta a ponta sai de `docs/PROMPT-INSTALAR.md`, e não de um literal: quem amarra o arquivo ao código é o teste de unidade, e o loader do Playwright não lê o import de JSON das mensagens.

Atualizados: `tests/e2e/transcricao-api.spec.ts` (o `ligarMotorPelaTela` passou a escolher o painel antes de ver o aviso de privacidade, o custo, o limite, a chave e o endereço, que agora moram dentro dele, e a ligar pelo botão da linha da situação; o teste do motor desligado escolhe o painel para os campos aparecerem, e escolher o painel não liga nada) e `tests/e2e/pacote-loja.spec.ts` (o `npm run` do passo a passo).

### Não feito

- O usuário continua sem ter transcrito uma call de verdade pela API com a chave dele (Emenda 21): o formato da resposta segue vindo da documentação.
- O prompt nunca foi rodado de ponta a ponta num Mac limpo: ele é a soma de fatos conferidos aqui, não uma instalação medida do zero.
- O site **não** foi publicado, e nada foi enviado à loja.
- O passo a passo do motor local não tem um botão que instale nada: quem instala é o Claude Code (ou a pessoa, no terminal).

O contrato que nenhuma parte muda sozinha passa a incluir `EnginePanel`, `engineSituation` (os oito `kind`), `INSTALL_STEPS`/`installPrompt` como a fonte única do passo a passo, de `docs/PROMPT-INSTALAR.md` e da seção do site, `currentMessageLocale()` e as chaves `trSit*`, `trSetup*`, `step*` e `prompt*`.
