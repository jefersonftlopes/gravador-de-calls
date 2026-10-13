# Gravador de Calls

Extensão do Chrome que grava sozinha, aba por aba, o áudio dos **outros participantes** das calls do Google Meet e do Microsoft Teams, junto com os dados da call, numa pasta escolhida, e transcreve cada call ao final, na própria máquina (whisper.cpp). O seu microfone não entra na gravação. Nada sai da máquina.

O que precisa acontecer está em [ESPEC.md](./ESPEC.md); como funciona, em [docs/ARQUITETURA.md](./docs/ARQUITETURA.md).

A interface fala português e inglês: por padrão segue o idioma do Chrome (português com o Chrome em português, inglês nos outros), e em **Configurações > Idioma** cada perfil pode escolher Português (Brasil) ou English (ver [Idioma](#idioma)). Sem o helper local, que ainda não é distribuído pela loja, a extensão funciona inteira e salva em `Downloads/Gravações de calls` (com o Chrome em inglês, `Downloads/Call recordings`); a pasta escolhida e a transcrição no seu computador são recursos avançados de quem instala o helper. A transcrição também funciona **sem o helper**, pela API de um provedor, com a chave do próprio usuário (ver [Transcrição pela API](#transcrição-pela-api-da-openai-050)).

Na primeira instalação abre uma página de boas-vindas que diz o que é gravado e lembra que gravar pode exigir o consentimento de todos os participantes. **A gravação automática só começa depois do "Entendi"** dessa página (em cada perfil). Quem atualiza de uma versão anterior não precisa confirmar de novo.

> Estado: as seis fatias estão integradas (Meet e Teams, as quatro fontes de captura, recuperação e destino Downloads, modo aba, popup e configurações, e o "sair sozinho"), a transcrição automática (0.2.0, Emenda 13), o volume por aba (0.2.1, Emenda 14) o preparo para a Chrome Web Store (0.3.0, Emenda 15: português e inglês, aviso na primeira execução, uso sem helper, pacote da loja) a escolha de quando sair da call escrita por extenso (0.3.1, Emenda 16) as correções de uso real da 0.3.1 (Emenda 17: Teams pelo proxy do Defender for Cloud Apps, captura presa por outra extensão, aviso de versão e recarga sozinha) quem disse o quê na transcrição (0.4.0, Emenda 18), o idioma escolhido nas configurações (0.4.1, Emenda 19) as correções da primeira daily real do Meet (0.4.2, Emenda 20) e a transcrição pela API de um provedor, dentro da extensão, para quem não tem o helper (0.5.0, Emenda 21). Os testes automáticos usam páginas que imitam o Meet e o Teams; falta a verificação numa call de verdade, com outra pessoa falando, que só o usuário consegue fazer.

## Construir e publicar

```bash
npm install
npm run publicar     # build + cópia para ~/Library/Application Support/gravador-de-calls/extensao
```

Os perfis do Chrome carregam a pasta **publicada**, não o `dist/`. Todo `npm run build` (e o `npm run test:e2e`, que faz o build antes) apaga e reescreve o `dist/` com nomes novos, e o `npm run dev` passa a servir o `dist/` por localhost: com os perfis apontando para o `dist/`, mexer no projeto no meio do expediente quebrava as calls abertas. A pasta publicada só muda quando você roda `npm run publicar`.

## Carregar no Chrome (uma vez por perfil)

1. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
2. **Carregar sem compactação** e escolha `~/Library/Application Support/gravador-de-calls/extensao` (no seletor, **Cmd+Shift+G** e cole o caminho; a pasta `Library` fica escondida no Finder).
3. **Fixe o ícone**: clique no quebra-cabeça ao lado da barra de endereço e no alfinete do Gravador de Calls. O Chrome não fixa sozinho uma extensão carregada sem compactação, e é no ícone que aparecem o REC, o REC âmbar ("sem áudio") e o ↻ ("recarregue a aba"). As configurações lembram enquanto ele não estiver fixado.
4. Repita em cada perfil do Chrome que tem calls (um por empresa). O ID da extensão é o mesmo em todos (`npm run id` mostra): vem da chave pública em `extension-key.json`.
5. Em **Configurações** de cada perfil, dê um nome ao perfil (ex.: Trabalho). Ele é salvo ao sair do campo.

## Idioma

No topo das **Configurações**, **Idioma**: **Automático (idioma do Chrome)** (o padrão), **Português (Brasil)** ou **English**, em cada perfil. Vale na hora, sem recarregar nada e sem o **Salvar**: as configurações (o que já foi digitado nos outros campos continua lá), o popup, a página de boas-vindas, o título do ícone, as notificações novas, o indicador do "sair sozinho" na página da call e, nas próximas gravações, os nomes da pasta, os rótulos dos falantes ("Você"/"You") e o cabeçalho do `transcricao.md` (este com o helper 0.4.1, `npm run instalar`, e só com Português ou English escolhidos: no Automático ele continua em português, como antes). Não mudam, porque o Chrome não deixa: o nome e a descrição da extensão em `chrome://extensions` e na loja, e a descrição do atalho do modo aba. A pasta de reserva em Downloads também continua pelo idioma do Chrome, para as gravações não se dividirem em duas pastas quando você troca o idioma.

## Instalar o helper (grava na pasta escolhida)

```bash
npm run instalar     # registra o helper para o Chrome deste usuário
npm run desinstalar  # remove
```

O helper é um script Node sem dependências (`host/gravador-host.mjs`, com `host/transcricao.mjs` e o worker `host/transcrever.mjs`) que o Chrome abre por native messaging. A instalação:

- **copia** os três arquivos do helper e um wrapper para `~/Library/Application Support/gravador-de-calls/bin/`, fora de `~/Documents`. Quem abre o helper é o Chrome, e o macOS (Privacidade e Segurança) trata o Chrome como o responsável: um script dentro de `~/Documents` pediria a permissão da pasta Documentos para o Chrome no meio da primeira call, ou falharia calado e tudo iria para Downloads;
- grava o manifesto em `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (um só, atende todos os perfis);
- manda o stderr do helper para `~/Library/Logs/gravador-de-calls/helper.log` (é lá que fica o motivo quando ele não abre).

O wrapper chama o `node` pelo caminho absoluto de quem instalou e, se ele sumir (um `nvm uninstall`, um `brew upgrade` com limpeza), tenta `/opt/homebrew/bin/node`, `/usr/local/bin/node` e o default do nvm. Não precisa recarregar a extensão depois de instalar: um perfil sem gravação passa para o helper novo até 30 s depois de você fechar o popup e as configurações (desde a 0.4.2; antes, o helper que o Chrome tinha aberto continuava rodando o código antigo enquanto o popup tivesse sido aberto). Uma gravação em andamento termina com o helper de antes, e a próxima já usa o novo.

**Rode `npm run instalar` de novo** depois de atualizar o projeto (a cópia do helper acompanha), de mover a pasta do projeto ou de trocar a versão do Node. Da 0.1 para a 0.2 isso é obrigatório: sem reinstalar, o helper antigo não transcreve, e as configurações e o popup dizem isso.

Uma cópia da extensão com outro ID (a da Chrome Web Store, por exemplo) usa o mesmo helper com `npm run instalar -- --id <id>` (pode repetir ou separar por vírgula); o ID de desenvolvimento continua valendo. Quando o helper está instalado mas não abre, o popup e as configurações dizem isso, com o erro do Chrome, em vez de "não instalado".

**Permissão da pasta.** A pasta padrão das gravações é `~/Documents/Gravações de calls`, que também é protegida: na primeira vez, o macOS pode pedir para o **Google Chrome** acessar a pasta Documentos. Para isso não acontecer no meio de uma call, depois de instalar abra as **Configurações** e clique em **Usar esta pasta** (ou escolha outra pasta): se o pedido aparecer, aceite ali. Se ele já foi recusado, libere em Ajustes do Sistema > Privacidade e Segurança > Arquivos e Pastas > Google Chrome.

## Onde ficam os arquivos

Padrão: `~/Documents/Gravações de calls`. Troque em **Configurações** (digitando o caminho ou pelo seletor do macOS): a escolha fica no helper, em `~/Library/Application Support/gravador-de-calls/config.json`, e vale para todos os perfis.

```
<pasta>/[<perfil>/]2026-10/2026-10-06 14h30 - Daily do time (Meet)/
  audio.webm        (Opus mono 32 kbps, cerca de 14 MB por hora)
  falantes.json     (quem falou e quando, quando a call disse; ver "Quem disse o quê")
  info.json         (escrito por último: plataforma, título, código, URL, início, fim, duração, captura...)
  transcricao.md    (depois, com a transcrição ligada: cabeçalho e a fala com o tempo)
  transcricao.srt
  transcricao-aba.md (e .srt, só quando o modo aba gravou nesta pasta)
```

O nível `<perfil>/` só existe quando o perfil tem nome. Durante a call o áudio é escrito aos poucos em `<pasta>/.gravando/<sessão>/`. Gravações com menos de 30 s são descartadas. Duas calls com o mesmo nome no mesmo minuto viram `X` e `X (2)`.

Se uma gravação não puder ser salva no fim (helper e Downloads falhando), o ícone ganha um **!** âmbar, uma notificação avisa, e o popup lista a gravação em "Ainda não salvas", com o motivo e **Tentar agora**. O áudio fica guardado na extensão e ela tenta de novo a cada minuto: não remova a extensão enquanto houver alguma nessa lista.

## Atualizar

1. `npm run publicar` (e `npm run instalar`, se o helper mudou).
2. **Os perfis recarregam sozinhos** (0.3.1, Emenda 17): o service worker de cada perfil confere o `publicado.json` da pasta publicada a cada minuto e, quando a versão é outra, recarrega a extensão assim que nada estiver em uso: nenhuma gravação (nem uma sendo salva, nem uma captura de aba começando), nenhuma aba do Meet ou do Teams aberta, nenhum volume de aba fora de 100% e a página de configurações fechada. Até lá o ícone mostra **↑** e o popup avisa "Este perfil ainda está com a versão X da extensão rodando...", com o motivo da espera e o botão **Recarregar agora** (desligado durante uma gravação).
3. Para recarregar já: **Recarregar agora** no popup ou nas configurações, ou `chrome://extensions` > **Recarregar**. Depois, recarregue as abas de call que estavam abertas (o ícone mostra ↻ nelas e o popup avisa).

**Recarregar ou atualizar a extensão encerra na hora as gravações em andamento daquele perfil** (elas são salvas como "interrompida"), e as abas abertas só voltam a gravar depois de recarregadas, o que sai da call. Por isso a recarga sozinha espera, e o botão fica desligado durante uma gravação.

Por que isso existe: o Chrome guarda o script do service worker de uma extensão sem compactação até ela ser recarregada, mas lê o popup e as configurações do disco a cada abertura. Sem recarregar, o popup novo conversa com o service worker antigo (achado de 08/10/2026: o volume da aba não fazia nada). O popup e as configurações comparam a versão delas com a do service worker e avisam; um pedido que o service worker antigo não conhece aparece como erro, em vez de não fazer nada.

Da 0.3.0 (ou antes) para a 0.3.1 a recarga sozinha ainda não existe no perfil: dessa vez, use o **Recarregar agora** do popup (ou o `chrome://extensions`). A recarga sozinha só existe na cópia publicada pelo `npm run publicar` (o pacote da loja e o `dist/` não têm o `publicado.json`) e depende do **Modo do desenvolvedor** ligado no perfil, que já é o caso de quem carregou a pasta sem compactação: com ele desligado, o Chrome desliga a extensão recarregada.

## Teams pelo proxy da empresa

O Teams aberto pelo proxy do **Microsoft Defender for Cloud Apps** (o endereço termina em `.mcas.ms`, como `teams.cloud.microsoft.mcas.ms`, ou em `.mcas-gov.us` e `.mcas-gov.ms`) grava como o Teams normal (0.3.1). O mesmo vale para o Meet aberto por esse proxy.

## Sair sozinho da call

Desligado por padrão. Em **Configurações**, ligue **Sair e fechar a aba quando a call esvaziar** e escolha em **Quando sair**:

- **Quando eu ficar sozinho na call**;
- **Quando sair boa parte das pessoas**: restar três quartos, metade, 30% (o padrão, a regra do script original) ou um quarto do maior número de pessoas que a call teve. Numa call que nunca chegou a 4 pessoas, só sai quando você ficar sozinho;
- **Quando restarem N pessoas ou menos, contando você** (de 1 a 50). Só vale numa call que já teve mais que N pessoas; antes disso, só sai quando você ficar sozinho.

**Confirmar antes de sair** (na hora, 10 s, 20 s ou 30 s) é o tempo em que a contagem precisa continuar baixa antes de sair, para um número errado de um instante não tirar você da call. Ficar sozinho sai na hora, em qualquer escolha. Embaixo, um exemplo muda junto com as escolhas ("numa call que chegou a 10 pessoas, o vigia sai quando restarem 5 ou menos, depois de 20 s confirmando"). Os números que quase ninguém mexe (de quanto em quanto tempo conferir, quando considerar que a call acabou e os detalhes da regra da proporção) ficam em **Ajustes finos**. Quem já usava antes da 0.3.1 continua com a mesma regra: a configuração antiga vira "boa parte das pessoas" com os mesmos números.

A aba só fecha depois de a gravação ser salva. O popup mostra a contagem, o maior número da call e com quantos o vigia sai ("6 na call · pico 10 · sai com 5 ou menos"), e tem **Sair agora** e **Desligar nesta call**.

## Modo aba (plano B)

Quando a gravação automática não pega áudio (o badge fica âmbar e uma notificação avisa), use **Alt+Shift+G** (Option+Shift+G no Mac; troque em `chrome://extensions/shortcuts`) ou o botão **Gravar esta aba (modo aba)** do popup. Ele grava o que a aba toca pela captura de aba do Chrome e você continua ouvindo a call. O arquivo `audio-aba.webm` entra na pasta da call em andamento ou numa pasta própria; numa aba fora do Meet e do Teams a pasta termina em `(Outro site)`. O mesmo atalho ou botão para.

Atenção: durante o modo aba o som da call sai na **saída padrão do macOS**, não no alto-falante ou fone escolhido dentro do Meet ou do Teams (o Chrome tira o som da aba e a extensão o devolve pela saída padrão). Se você usa um fone diferente da saída padrão, troque a saída padrão do sistema antes.

## Volume desta aba

O popup tem a seção **Volume desta aba** (de 0% a 200%, como o Volume Master) em qualquer página http ou https. O volume vale só para o que você ouve: nenhuma gravação muda de nível, nem a automática nem a do modo aba. Fora de 100%, o som da aba sai pela **saída padrão do computador**, não pelo fone escolhido dentro do site (é a mesma captura de aba do modo aba). Em 100% a extensão solta a aba e ela volta ao dispositivo dela. O volume é da aba, como no Volume Master: continua depois de navegar, inclusive para outro site, e só volta a 100% quando você fecha a aba ou aperta **100%**. Se a aba estiver numa página em que o volume não começa (`chrome://`, PDF), o popup ainda mostra o controle enquanto o volume valer, para voltar a 100% dali mesmo. Acima de 100% um limitador segura os picos para o som não estourar. Se você desligou o som repetido durante uma gravação do modo aba, parar a gravação solta a aba (o volume volta a 100%), para o som não voltar em dobro.

**Outra extensão de volume (o Volume Master, por exemplo) e esta não podem capturar a mesma aba**: o Chrome só deixa uma captura por aba, e o Volume Master não solta a dele. Nesse caso o modo aba e o volume desta aba dizem "Outra extensão (por exemplo, o Volume Master) já está capturando o som desta aba..." (0.3.1). Desligue a outra extensão em `chrome://extensions`, ou feche e reabra a aba, e tente de novo.

## Transcrição automática

Duas maneiras, e você escolhe em **Configurações > Transcrição**: no **seu computador** (whisper.cpp, pelo helper local) ou pela **API de um provedor**, com a sua chave, sem instalar nada (0.5.0). O resultado é o mesmo par de arquivos na pasta da call, com os nomes de quem falou.

### No seu computador (whisper.cpp)

Com o helper instalado e a transcrição ligada (padrão), cada call salva é transcrita logo depois, na própria máquina: aparecem `transcricao.md` e `transcricao.srt` na pasta da call, e o popup mostra "Transcrevendo..." e depois **Abrir transcrição** em cada uma das últimas gravações. Quem transcreve é um processo separado que o helper abre: ele continua com o Chrome fechado, faz uma gravação por vez com prioridade baixa e retoma o que ficou pela metade. O motivo de cada passo fica no log do helper (`~/Library/Logs/gravador-de-calls/helper.log`).

Precisa do whisper.cpp, do ffmpeg e de um modelo (nada é baixado sozinho):

```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/Library/Application\ Support/gravador-de-calls/modelos
curl -L -o ~/Library/Application\ Support/gravador-de-calls/modelos/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

A pasta recomendada para o modelo é a do próprio Gravador, `~/Library/Application Support/gravador-de-calls/modelos` (fora do projeto e da pasta publicada, que é trocada a cada `npm run publicar`). Se você já tem o modelo em outro lugar no mesmo disco, `cp -c` cria um clone instantâneo, sem ocupar espaço a mais. Sem modelo escolhido, o helper usa o melhor que achar nessa pasta, em `~/.cache/whisper-models`, `~/.whisper-models` e nas pastas do whisper-cpp do Homebrew (large-v3-turbo, large-v3, large-v2, medium, small, base, tiny, nessa ordem). Em **Configurações > Transcrição** (vale para todos os perfis): ligar ou desligar, o modelo (caminho ou **Escolher modelo...**), o idioma (detectar sozinho, português...) e os caminhos dos programas; a seção diz se dá para transcrever agora e, se não, por quê.

Sem o whisper.cpp, o ffmpeg ou o modelo, as calls não se perdem: ficam na fila com o motivo ("Na fila, esperando: ..." no popup) e são transcritas quando o que falta aparecer (ao salvar a configuração certa, ou quando o Chrome abrir o helper de novo depois de instalar). Se uma transcrição falhar de verdade, o `info.json` da pasta diz o motivo em `transcricao.erro` e o áudio continua lá.

Com o modo aba na pasta da call, o `audio-aba.webm` também é transcrito: aparecem `transcricao-aba.md` e `transcricao-aba.srt`, e o popup passa a abrir essa (é o plano B de quando a gravação da página não pegou o áudio). O `info.json` guarda o estado de cada áudio em `transcricoes`.

### Transcrição pela API da OpenAI (0.5.0)

Para quem não tem o helper (ou não quer o whisper.cpp, o ffmpeg e um modelo de alguns GB): a extensão manda o áudio da call para a API de transcrição da OpenAI, com a **sua** chave, e recebe o texto de volta. Em **Configurações > Transcrição**, escolha "A API da OpenAI, com a sua chave", cole a chave e pronto.

> **O que sai do seu computador:** o áudio da call, com a voz dos participantes, vai para o servidor da OpenAI. **Só o áudio**: nenhum nome de participante e nenhum outro arquivo da gravação; os nomes de quem falou são casados com o texto depois, aqui na sua máquina. A tela avisa isso antes de você ligar. Grave e transcreva uma call só com o consentimento de quem participa.

- **Desligada por padrão e por perfil do Chrome:** ligar num perfil não liga nos outros, porque mandar o áudio para fora é decisão de cada empresa ou cliente.
- **A chave fica só nesta máquina**, neste perfil, num espaço próprio do armazenamento da extensão, e é usada apenas no cabeçalho da requisição. Ela não vai para o `info.json`, para o log nem para nenhuma mensagem de erro. A tela mostra só os quatro últimos caracteres, e dá para apagar. Crie a sua em [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
- **Custo:** cerca de **US$ 0,36 por hora de call** (modelo `whisper-1`, 0,006 dólar por minuto), cobrados pela OpenAI na sua conta. O modelo é esse porque é o único que devolve os tempos de cada trecho, que é o que permite casar a fala com quem falou.
- **Permissão:** o Chrome pede a sua autorização para a extensão falar com `api.openai.com` no momento em que você liga. Sem ela, nada é enviado.
- **Call longa:** acima de 25 MB (cerca de 1 h 49 no formato que gravamos) a call não é enviada, porque é o limite da API por requisição. A gravação fica com o aviso, e o motor local transcreve se você tiver o helper.
- **Se der errado:** uma chave recusada não é tentada de novo (corrija a chave nas configurações); limite de uso, erro do servidor e falta de rede são tentados de novo, com espera crescente, e o popup diz o motivo em cada gravação.
- **Enquanto espera**, o áudio fica guardado no navegador, e só até a transcrição terminar: no máximo 5 tentativas, 24 horas e 300 MB somados. Estourando qualquer um, o áudio guardado é apagado (a gravação na pasta nunca é tocada) e a gravação fica com o motivo.
- **Com o helper instalado**, este motor exige o helper 0.5.0 ou mais novo (`npm run instalar`): senão os dois transcreveriam a mesma call e um sobrescreveria o outro.
- **Nenhuma requisição foi feita à API de verdade** nos testes (eles usam um servidor falso local e uma chave falsa). A primeira transcrição real, com a sua chave, é a conferência que falta.

### Quem disse o quê (0.4.0)

Durante a call a extensão anota quem está falando, só com o que o Meet e o Teams já mandam para a página (nada é clicado, nenhum painel é aberto, a legenda não é ligada), e mede no seu microfone se você está falando (só o volume, para marcar o momento; o microfone continua fora da gravação). No fim, a pasta da call ganha o `falantes.json` (a linha do tempo, em ms desde o começo do `audio.webm`) e o `info.json` ganha `falantes` (quem falou e por quantos segundos). A transcrição usa isso:

```
[00:03] Ana Souza: Bom dia a todos. Vamos começar.
[00:09] Bruno Lima: Obrigado, Ana.
[00:14] Você: (sua fala não é gravada)
[00:20] Ana Souza: Voltando ao assunto.
```

Cada trecho do whisper fica com quem mais falou naquele intervalo; quem a plataforma não nomeou aparece como "Participante 1", "Participante 2"; a linha "Você" só entra onde a gravação não tem fala da call. O `.srt` também leva o nome. Sem nenhum sinal de quem falou (uma página que mudou, uma call sem esses sinais), a transcrição sai como antes, sem nomes.

Desde a 0.4.2 (Emenda 20, depois da primeira daily real): uma fonte sem nome que só aparece junto de quem fala, e quase sempre que alguém fala, não é uma pessoa e sai (no Meet era um marcador de "quem está mais alto", e virava "Participante 1" em quase todo trecho); ela fica anotada no `falantes.json`, em `descartadas`. No Meet, o seu nome vem da lista de participantes que o Meet manda pela rede, e você sai da lista de participantes do `info.json`. A transcrição tira a repetição em laço do whisper (a mesma frase várias vezes seguidas), e um trecho sem falante entre dois da mesma pessoa fica com ela.

Para transcrever de novo uma gravação já salva (uma de antes da 0.4.2, para os nomes saírem certos), com a configuração da transcrição do helper:

```bash
npm run transcrever -- "<pasta da call>"
```

Ele troca o `transcricao.md` e o `transcricao.srt` da pasta; o áudio e o `falantes.json` ficam.

De onde vem: no Meet, o id de quem está no áudio (CSRC dos pacotes) com a lista de participantes que o Meet manda pela rede; quando o Meet decodifica o áudio ele mesmo, o sinal de fala que o servidor manda pelo canal `dcrpc`; com a aba na tela, o medidor de voz do bloco. No Teams, o mesmo id com o objeto da call, o falante dominante do canal `main-channel` e, por último, o indicador do bloco de vídeo. Os formatos são internos e não documentados (`docs/pesquisa/falantes-2026-10-09.md`): **ainda não foram conferidos numa call de verdade com várias pessoas**, e só você pode fazer isso. Na primeira call, abra o `transcricao.md` e confira se os nomes batem com quem falou (com a aba na tela e em segundo plano). Precisa do helper 0.4.0 (`npm run instalar`): o anterior não escreve o `falantes.json`.

Para transcrever à mão uma gravação antiga:

```bash
ffmpeg -i audio.webm -af aresample=async=1 -ar 16000 -ac 1 -c:a pcm_s16le audio.wav
whisper-cli -m <modelo> -l pt -f audio.wav -osrt -oj
```

## Desinstalar

1. Confira antes: o popup sem gravação em andamento nem "Ainda não salvas", e `<pasta>/.gravando/` vazia (pasta oculta: Cmd+Shift+. no Finder).
2. Remova a extensão em cada perfil (`chrome://extensions` > Remover). Isso apaga o que ela guarda no perfil, inclusive o áudio de uma gravação que ainda não foi salva e o identificador do perfil: uma gravação interrompida que ficou em `.gravando/` não é mais recuperada sozinha depois disso (o áudio continua lá, em `audio.webm.part`).
3. `npm run desinstalar` tira o manifesto, o wrapper e a cópia do helper. Ficam no disco, de propósito: as gravações, `~/Library/Application Support/gravador-de-calls/config.json`, `sessoes/` e `fila/` (a pasta escolhida, a configuração da transcrição, os índices do helper e a fila da transcrição), a pasta publicada `extensao/` e o log em `~/Library/Logs/gravador-de-calls/`. Apague à mão se quiser.

## Testes

```bash
npm test             # unidade (vitest): nomes, arbitragem, protocolo do helper, transcrição (local e por API), instalação, medição de tons
npm run test:e2e -- --workers=1   # ponta a ponta (Playwright): constrói dist/ e grava calls falsas do Meet e do Teams
npm run teste:transcricao-real   # fora do npm test: fala do say do macOS transcrita pelo whisper-cli de verdade
```

Os testes da transcrição usam um ffmpeg e um whisper-cli falsos (scripts em pasta temporária); o teste real usa os desta máquina, numa pasta e num `config.json` temporários, e nunca baixa modelo.

O ponta a ponta usa o Chrome for Testing já baixado pelo Playwright (`~/Library/Caches/ms-playwright/chromium-*`, ou `GRAVADOR_CHROMIUM=<binário>`), em headless, com perfil temporário, o helper instalado só em `<perfil>/NativeMessagingHosts` (a cópia do helper e o wrapper ficam na pasta temporária do teste) e um `config.json` próprio (`GRAVADOR_CONFIG`) apontando para uma raiz temporária. Ele nunca abre o Chrome de marca nem toca no seu perfil, na sua pasta de gravações ou na pasta publicada.

O ponta a ponta roda com a interface do Chrome em português (os testes antigos conferem os textos em português) e alguns testes em inglês (`LaunchOptions.locale`). No macOS o Chrome ignora `--lang`: o harness abre o Chrome for Testing por um wrapper em `test-results/gravador/` que passa `-AppleLanguages (<idioma>)`. Cada perfil de teste confirma o aviso da primeira execução pela própria página de boas-vindas (`LaunchOptions.consent: false` deixa sem confirmar).

## Chrome Web Store

```bash
npm run empacotar    # artifacts/gravador-de-calls-<versão>.zip: o pacote da loja
```

O pacote da loja (`GRAVADOR_LOJA=1`) sai sem a chave de desenvolvimento, sem os ganchos de teste do service worker (`globalThis.__gravador`) e com `homepage_url` no site da política de privacidade (`https://gravador-de-calls.vercel.app`). O build de desenvolvimento e o `npm run publicar` continuam com a chave (o ID da extensão instalada sem compactação não muda) e com os ganchos. A justificativa de cada permissão e o que ainda falta para enviar à loja estão em [docs/LOJA.md](./docs/LOJA.md). Nada é enviado à loja por script: quem envia é você.

### Site, política de privacidade e listagem

O site estático da extensão fica em `site/` (HTML e CSS puros, sem build) e está no ar na Vercel, no projeto `gravador-de-calls` do seu time da Vercel:

- https://gravador-de-calls.vercel.app (início em português) e https://gravador-de-calls.vercel.app/en
- https://gravador-de-calls.vercel.app/privacidade e https://gravador-de-calls.vercel.app/en/privacy (a URL da política que vai no painel da loja)

```bash
cd site && vercel deploy --prod --scope <seu-time>   # publica de novo (cleanUrls no vercel.json)
```

As duas políticas descrevem a extensão como ela é: mudou permissão, o que vai para o `info.json` ou onde o áudio fica, atualize as duas e a data de vigência antes de enviar a versão nova à loja. Os textos para colar no painel (nome, resumo, descrição, categoria, propósito único, justificativa de cada permissão, práticas de dados e instruções para o revisor) estão em [docs/loja/listagem-pt_BR.md](./docs/loja/listagem-pt_BR.md) e [docs/loja/listagem-en.md](./docs/loja/listagem-en.md); as capturas e o bloco promocional, em `docs/loja/capturas/` e `docs/loja/promo-440x280*.png`, gerados por `npm run capturas` (roteiro em [docs/loja/capturas.md](./docs/loja/capturas.md)). O passo a passo para enviar ao painel da loja está em [docs/loja/ENVIAR.md](./docs/loja/ENVIAR.md).

O ícone sai de `assets/icone/icon.svg` (e `icon-16.svg`, desenhado na grade de 16 px), fora de `public/` para os SVGs não irem no pacote. Para gerar os PNGs de `public/icons` de novo: `node scripts/renderizar-icones.mjs --amostra` (Chrome for Testing do Playwright; a folha de conferência em fundo claro e escuro vai para `artifacts/icones/amostra.png`). Se o ícone mudar, copie `icon.svg`, `icon32.png` e `icon128.png` para `site/img/` (`icone.svg`, `icone-32.png`, `icone-128.png`) e publique o site.
