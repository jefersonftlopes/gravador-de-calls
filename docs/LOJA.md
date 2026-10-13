# Chrome Web Store: o que falta

Lista de trabalho para publicar a extensão na Chrome Web Store. Nada aqui foi enviado à loja. O ponto de partida está pronto desde a 0.2.0 (Emenda 13 em `docs/ARQUITETURA.md`):

- `npm run empacotar` gera `artifacts/gravador-de-calls-<versão>.zip` sem a chave de desenvolvimento (a loja recusa `key` e dá o ID dela) e sem os mapas de fonte. O build de desenvolvimento continua com a chave.
- `npm run instalar -- --id <id da loja>` deixa a cópia da loja usar o mesmo helper.
- O código, os testes e os documentos de trabalho não têm nomes de pessoas nem de empresas (`docs/pesquisa` e `docs/referencia` ficam como registro da pesquisa).
- A transcrição tem uma interface de motores (`ENGINES` em `host/transcricao.mjs`) pronta para os motores abaixo.

Na 0.3.1 (Emenda 17), junto com a 0.3.0 que está em revisão:

- **Hosts novos = revisão nova.** A 0.3.1 acrescenta os hosts do proxy do Defender for Cloud Apps (`*.mcas.ms`, `*.mcas-gov.us`, `*.mcas-gov.ms` sobre os quatro hosts das calls) aos `host_permissions` e aos content scripts. Permissão de host nova muda o aviso da instalação e faz a loja revisar o pacote de novo; numa extensão já publicada, o Chrome ainda desliga a cópia instalada até o usuário aceitar a permissão nova. Como a 0.3.0 não foi publicada, ninguém é desligado; o passo a passo de trocar o pacote em revisão está em `docs/loja/ENVIAR.md`.
- O erro "Cannot capture a tab with an active stream" (outra extensão, como o Volume Master, segurando a captura da aba) virou uma mensagem que diz o que fazer, nas duas línguas.
- A recarga sozinha da extensão (`publicado.json`) só existe na cópia publicada por `npm run publicar`; no pacote da loja ela não faz nada (sem o arquivo e com `__STORE_BUILD__`). O aviso de versão diferente entre a página e o service worker vale nos dois.

Pronto na 0.3.0 (Emenda 15 em `docs/ARQUITETURA.md`), para a primeira versão da loja:

- A loja vai **sem o helper**: a extensão funciona inteira sem ele (gravação automática por aba salva em `Downloads/<pasta>`, volume da aba, sair sozinho, modo aba). A pasta escolhida e a transcrição continuam para quem tem o helper e aparecem em "Avançado" como recursos opcionais ("exige o helper local, ainda não distribuído pela loja"), nunca como erro.
- Português e inglês por `chrome.i18n` (`public/_locales/en` e `public/_locales/pt_BR`, `default_locale: en`), inclusive nome, descrição, título do ícone e descrição do atalho no manifesto. A pasta em Downloads segue o idioma: `Gravações de calls` ou `Call recordings`.
- Boas-vindas e aviso de consentimento na instalação, com "Entendi"; até confirmar, a gravação automática não começa.
- `npm run empacotar` faz o build com `GRAVADOR_LOJA=1`: sem `key`, sem o gancho de teste `globalThis.__gravador` (nem o registro de ganchos), com `homepage_url: https://gravador-de-calls.vercel.app`.
- Política de privacidade: site estático no Vercel (`gravador-de-calls.vercel.app/privacidade` e `/en/privacy`), feito em paralelo; o link está nas boas-vindas e nas configurações.

## 1. Política de privacidade e aviso de consentimento

A extensão grava outras pessoas. Isso precisa estar claro antes da primeira gravação, não só na listagem.

- **Política de privacidade** publicada numa URL (a loja exige para quem lida com áudio): o que é gravado (só o áudio que chega dos outros participantes, nunca o microfone), onde fica (só no disco do usuário, na pasta escolhida, ou em Downloads), o que a transcrição faz (na própria máquina; com o motor na nuvem, o que sai e para quem), por quanto tempo fica (até o usuário apagar), e que a extensão não tem servidor nem coleta nada.
- **Aviso de consentimento na primeira execução**: feito na 0.3.0 (`src/welcome`). Fica para depois: um lembrete opcional, durante a call, para avisar os participantes.
- **Formulário de práticas de dados** do painel do desenvolvedor: declarar "conteúdo do site" e "comunicações pessoais" (áudio das calls), uso limitado, sem venda nem transferência.
- **Propósito único** na listagem: gravar e transcrever as calls do Meet e do Teams no computador do usuário.
- Marcas: "Google Meet" e "Microsoft Teams" só para dizer com o que funciona, sem sugerir parceria; o nome e o ícone não podem usar as marcas deles.

## 2. Justificativa de cada permissão

O painel pede uma frase por permissão. Revisadas na 0.3.0 (Emenda 15): nenhuma saiu, porque cada uma serve a uma função da versão da loja ou ao helper, que continua para quem o instala. A permissão `tabs` já tinha saído antes (os `host_permissions` das calls dão URL e título dessas abas). `tests/unit/pacote-loja.test.ts` falha se o manifesto ganhar uma permissão que não está nesta tabela.

| Permissão | Por quê |
|---|---|
| `host_permissions` (meet.google.com, teams.microsoft.com, teams.cloud.microsoft, teams.live.com, e cada um deles com `.mcas.ms`, `.mcas-gov.us` e `.mcas-gov.ms` no fim) | Os scripts de conteúdo rodam só nas páginas das calls, para detectar quando a call começa e acaba e gravar o áudio que a página recebe. Também dão o título e a URL dessas abas ao popup. Os hosts com sufixo (0.3.1, Emenda 17) são as mesmas páginas abertas pelo proxy de sessão do Microsoft Defender for Cloud Apps (Conditional Access App Control), como a empresa que abre o Teams em `teams.cloud.microsoft.mcas.ms`. A lista sai de `src/shared/hosts.ts`. |
| Script no MAIN world em `document_start`, `all_frames`, `match_origin_as_fallback` | O Meet e o Teams criam a conexão de áudio cedo e às vezes num iframe; os ganchos precisam estar lá antes. Eles só observam (não mudam o que as APIs devolvem). Vale explicar porque o revisor vai ver `RTCPeerConnection` embrulhado. |
| `storage` | Configurações de cada perfil e a lista das últimas gravações. |
| `unlimitedStorage` | O áudio fica no IndexedDB da extensão até ser salvo na pasta; uma call longa não pode bater na cota e perder o fim. |
| `offscreen` | Montar o arquivo para o download (reserva sem o helper) e gravar no modo aba. |
| `nativeMessaging` | Falar com o helper local, que grava na pasta escolhida e transcreve. Na versão da loja ele é opcional (recurso avançado, ainda não distribuído pela loja); sem ele a extensão não abre nada. Fica porque tirar a permissão quebraria a pasta escolhida e a transcrição de quem já usa o helper (decisão de 07/10/2026). Passar para `optional_permissions`, pedida só quando o usuário ligar o helper, é a alternativa a avaliar quando o helper for distribuído (não conferido se o Chrome aceita `nativeMessaging` como opcional). |
| `downloads` | Destino das gravações sem o helper (o caso normal da loja): `Downloads/Gravações de calls` ou `Downloads/Call recordings`, conforme o idioma, e o "Mostrar na pasta" das últimas gravações. |
| `notifications` | Avisar que uma gravação não está pegando áudio, que uma aba precisa ser recarregada, ou que uma gravação não foi salva. |
| `tabCapture` | Modo aba (plano B), só pelo atalho ou pelo botão do popup. |
| `activeTab` | Título e URL da aba no mesmo gesto que libera o modo aba fora do Meet e do Teams. |
| `alarms` | Tentar de novo salvar uma gravação interrompida depois de uma queda, e repetir as tentativas da transcrição por API (Emenda 21). |
| `optional_host_permissions`: `https://api.openai.com/*` (Emenda 21, 0.5.0) | A transcrição por API, com a chave do próprio usuário. É OPCIONAL: não aparece no aviso da instalação e é pedida com `chrome.permissions.request` na hora em que o usuário liga o motor nas configurações. Nada é enviado sem ela. Só a origem do provedor declarado (`src/shared/api-transcription.ts`, `API_PROVIDERS`); nada de `https://*/*`. O build de desenvolvimento acrescenta `http://127.0.0.1/*`, o servidor falso dos testes, que o pacote da loja não leva. |

Outras declarações do painel:

- **Código remoto: não.** Todo o código está no pacote (Vite junta tudo; nenhum `<script>` de fora, nenhum `import()` de URL, `importScripts`, `eval` ou `Function()`, conferido em `tests/unit/pacote-loja.test.ts`). A única ocorrência de `Function(` no pacote é o teste interno do zod (`allowsEval`, que vê se pode compilar validadores): a extensão liga o `jitless` do zod (`src/shared/zod.ts`) antes de qualquer schema, então esse teste nunca roda. Se um revisor perguntar, é isso. A extensão não faz pedido de rede nenhum: o único endereço de fora é o link da política de privacidade, aberto pelo usuário numa aba.
- `homepage_url`: o site com a política de privacidade (só no pacote da loja).
- `minimum_chrome_version: 120`: ver a seção 9.

## 3. Tradução com `chrome.i18n`

Feito na 0.3.0 (Emenda 15): mensagens em `public/_locales/{en,pt_BR}/messages.json`, `t()`/`tp()` em `src/shared/i18n.ts`, os motivos do helper traduzidos na extensão por `src/shared/helper-reasons.ts`. Fica para depois:

- `transcricao.md` tem os rótulos do cabeçalho em português (recurso só do helper): seguir o idioma da interface quando o helper for para a loja.
- As chaves do `info.json` não mudam com o idioma: são contrato. As palavras do nome da pasta da call seguem o idioma da interface, como a pasta em Downloads (`Sem título`/`Untitled`, `(Outro site)`/`(Other site)`); `(Meet)` e `(Teams)` são nomes próprios. `Gravação recuperada` (o nome de um staging órfão do helper) continua em português: só acontece com o helper.
- O protocolo e o log continuam em português (dados): a fonte da contagem do vigia (`VigiaStatus.fonte`) e os motivos do offscreen são traduzidos na ponta (`src/shared/vigia-source.ts`, `src/shared/offscreen-reasons.ts`).

## 4. Instalador do helper para quem não é desenvolvedor

Hoje o helper se instala com `npm run instalar`, o que exige Node e o repositório.

- **macOS**: um `.pkg` assinado e notarizado que instala o helper (com um Node embutido, por exemplo como executável único do Node, para não depender do Node da máquina) em `~/Library/Application Support/gravador-de-calls/bin` e o manifesto em `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (por usuário) ou `/Library/Google/Chrome/NativeMessagingHosts/` (todos os usuários), com o ID da loja em `allowed_origins`. Desinstalador junto.
- **Windows**: instalador (MSI ou similar) que grava o manifesto numa pasta do usuário e a chave `HKCU\Software\Google\Chrome\NativeMessagingHosts\<nome do host>` apontando para ele; o helper precisa de um `.bat` ou executável no lugar do wrapper `.sh`, e o seletor de pasta e o "Mostrar no Finder" ganham as versões do Windows (hoje são `osascript` e `open -R`).
- **Linux**: o manifesto em `~/.config/google-chrome/NativeMessagingHosts/` (já é o que `defaultManifestDir` faz) e um pacote ou script.
- A extensão mostra, quando não acha o helper, um link para baixar o instalador do sistema certo em vez de `npm run instalar`.
- Decidir o nome do host de native messaging (hoje `com.enkode.gravador_calls`) junto com o nome de quem publica; trocar exige o instalador escrever o manifesto novo e, por um tempo, o antigo.
- O whisper.cpp e o ffmpeg também precisam de um caminho sem terminal (embutidos no instalador ou baixados por ele, com a licença de cada um), senão a transcrição local fica só para quem usa Homebrew.

## 5. Motor de transcrição no navegador

Para quem não instala o helper (ou não quer o whisper.cpp): Whisper rodando em WebGPU no documento offscreen.

- Código inteiro no pacote (biblioteca de inferência e WASM), porque o Manifest V3 proíbe código remoto. O modelo entra como dado: baixado sob demanda de uma URL fixa, com o hash conferido, e guardado no armazenamento da extensão (ou embutido, se o tamanho do pacote permitir).
- Novo motor na mesma interface (`{ id, available(), transcribe() }`), mas do lado da extensão: a fila hoje mora no helper; sem helper, a fila e o estado precisam morar no IndexedDB, e a saída vai por download junto com a gravação.
- `available()` diz "o navegador não tem WebGPU" ou "falta baixar o modelo (X MB)".

## 6. Motor na nuvem, opcional, com a chave do próprio usuário

**Feito na 0.5.0 (Emenda 21).** O que estava planejado aqui virou o motor `openai-api`, que roda dentro da extensão (service worker), por perfil do Chrome, desligado por padrão:

- ligar mostra, ANTES, o que sai da máquina (o áudio da call, com a voz dos participantes) e para qual serviço, e pede a chave da API do próprio usuário (nenhuma chave nossa);
- a chave fica em `chrome.storage.local`, numa chave de armazenamento própria, fora de `settings`, e só aparece no cabeçalho `Authorization`: nunca em log, em `info.json` ou em mensagem de erro;
- a permissão de host é opcional e pedida na hora de ligar (`chrome.permissions.request`);
- a política de privacidade do site (`site/privacidade.html` e `site/en/privacy.html`) e a divulgação de dados do painel da loja mudam por causa dele: ver a seção 1 e `docs/loja/ENVIAR.md`.

O que continua não feito: um motor na nuvem de outro provedor (o endereço já é dado, então é uma linha em `API_PROVIDERS`) e cortar uma call acima do limite de 25 MB por requisição.

## 7. Listagem

Pronta na 0.3.0: textos em `docs/loja/listagem-en.md` e `docs/loja/listagem-pt_BR.md`, cinco capturas de 1280x800 por idioma em `docs/loja/capturas/<idioma>/` e o bloco promocional de 440x280 (`docs/loja/promo-440x280*.png`), gerados por `npm run capturas` (`docs/loja/capturas.md`), e o ícone novo em `public/icons` (fonte em `assets/icone`). O passo a passo do envio está em [docs/loja/ENVIAR.md](./loja/ENVIAR.md).

- Quando o helper for para a loja: capturas com a transcrição ("Abrir transcrição" nas últimas gravações, a seção de transcrição nas configurações, uma pasta com `transcricao.md`).

## 8. Licença

Escolher a licença do repositório público (MIT, Apache-2.0, GPL...) é decisão do autor. Nenhum arquivo `LICENSE` foi adicionado: perguntar antes de publicar o repositório.

## 9. Antes de enviar, conferir também

- O gancho de depuração `globalThis.__gravador` no service worker: feito na 0.3.0, o pacote da loja não o tem.
- `minimum_chrome_version` (120) e o comportamento no Edge e no Brave, se forem publicar lá também.
- A verificação numa call real do Meet e do Teams (ESPEC, "Em aberto") continua bloqueando o "pronto".
