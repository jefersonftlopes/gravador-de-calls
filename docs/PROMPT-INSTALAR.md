# Prompt para instalar a transcrição local

<!-- Gerado por `npm run prompt` a partir de src/shared/instalar-local.ts. Não edite à mão: o
     teste tests/unit/prompt-instalar.test.ts falha quando este arquivo sai de sincronia com os
     passos do código. -->

Transcrever no próprio computador exige o whisper.cpp, o ffmpeg e um modelo de reconhecimento de
fala. A extensão mostra este mesmo passo a passo em Configurações, na seção Transcrição, dentro do
acordeão da opção "O seu computador". Copie o bloco da sua língua e cole no Claude Code.

## Português (Brasil)

```text
Instalar a transcrição local da extensão Gravador de Calls

Estou no macOS e quero transcrever as minhas calls no meu próprio computador, sem mandar o áudio para fora. A extensão Gravador de Calls já está instalada no Chrome. Falta instalar o programa que transcreve e ligar os dois. Faça isso por mim.

Projeto: https://github.com/jefersonftlopes/gravador-de-calls

Regras

1. Confira cada passo antes de começar o seguinte, e me diga o que achou.
2. Avise antes do download grande (o modelo de fala, 1,6 GB) e espere eu confirmar.
3. NÃO rode npm install neste projeto. O programa que transcreve, o worker e o teste importam só módulos do Node e caminhos relativos, e npm run funciona sem a pasta node_modules. Isso poupa centenas de MB.
4. Se um passo falhar, pare e me explique em linguagem simples o que deu errado e o que eu posso fazer.
5. Nunca apague arquivo meu e nunca mexa nas minhas gravações.
6. Se precisar da minha senha, pare e me diga o comando para eu rodar. Não peça a senha.

Passos

1. Conferir que este é um Mac: o programa que transcreve só tem instalador para macOS.
   Comandos:
       uname -s
   Confira: `uname -s` responde Darwin. Em qualquer outro sistema, pare e me diga que o instalador existe só para macOS.

2. O Node 22, o whisper.cpp e o ffmpeg, instalados pelo Homebrew.
   Comandos:
       brew install node
       brew install whisper-cpp
       brew install ffmpeg
   Confira: `node --version` é 22 ou mais novo, `whisper-cli --help` responde (ele fica em /opt/homebrew/bin/whisper-cli) e `ffmpeg -version` responde.

3. O projeto da extensão, baixado do GitHub para ~/Documents/gravador-de-calls.
   Comandos:
       git clone https://github.com/jefersonftlopes/gravador-de-calls.git ~/Documents/gravador-de-calls
   Confira: o arquivo package.json existe em ~/Documents/gravador-de-calls.

4. O modelo de reconhecimento de fala: 1,6 GB de download, o passo mais demorado.
   Comandos:
       mkdir -p "$HOME/Library/Application Support/gravador-de-calls/modelos"
       curl -L --fail -o "$HOME/Library/Application Support/gravador-de-calls/modelos/ggml-large-v3-turbo.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
       stat -f%z "$HOME/Library/Application Support/gravador-de-calls/modelos/ggml-large-v3-turbo.bin"
   Confira: o arquivo baixado tem exatamente 1624555275 bytes. Um arquivo cortado faz o whisper falhar sem explicar a causa.

5. A ligação entre a extensão do Chrome e o programa que transcreve.
   Comandos:
       cd ~/Documents/gravador-de-calls
       npm run instalar -- --id kpbjnbedejcbakdjacjmhaofidooddjp
   Confira: o comando terminou sem erro e o id kpbjnbedejcbakdjacjmhaofidooddjp aparece no manifesto do host que ele escreveu.

6. Uma call de teste, falada pelo próprio Mac, para provar que a transcrição funciona de ponta a ponta.
   Comandos:
       cd ~/Documents/gravador-de-calls
       npm run teste:transcricao-real
   Confira: o teste terminou dizendo que passou. Ele roda numa pasta temporária e não toca nas minhas gravações.

No fim, o que fica comigo

1. Escolher a pasta das gravações nas configurações da extensão.
2. Deixar a opção "O seu computador" escolhida em Transcrição, nas configurações da extensão.
```

## English

```text
Install local transcription for the Gravador de Calls extension

I am on macOS and I want my calls transcribed on my own computer, without sending the audio anywhere. The Gravador de Calls extension is already installed in Chrome. What is missing is the program that transcribes and the link between the two. Please do it for me.

Project: https://github.com/jefersonftlopes/gravador-de-calls

Rules

1. Check each step before starting the next one, and tell me what you found.
2. Warn me before the big download (the speech model, 1.6 GB) and wait for me to confirm.
3. Do NOT run npm install in this project. The program that transcribes, the worker and the test import only Node modules and relative paths, and npm run works without the node_modules folder. This saves hundreds of MB.
4. If a step fails, stop and explain in plain language what went wrong and what I can do.
5. Never delete a file of mine and never touch my recordings.
6. If you need my password, stop and tell me the command to run. Do not ask for the password.

Steps

1. Check that this is a Mac: the program that transcribes only has a macOS installer.
   Commands:
       uname -s
   Check: `uname -s` answers Darwin. On any other system, stop and tell me the installer only exists for macOS.

2. Node 22, whisper.cpp and ffmpeg, installed with Homebrew.
   Commands:
       brew install node
       brew install whisper-cpp
       brew install ffmpeg
   Check: `node --version` is 22 or newer, `whisper-cli --help` answers (it lives in /opt/homebrew/bin/whisper-cli) and `ffmpeg -version` answers.

3. The extension project, downloaded from GitHub into ~/Documents/gravador-de-calls.
   Commands:
       git clone https://github.com/jefersonftlopes/gravador-de-calls.git ~/Documents/gravador-de-calls
   Check: the file package.json exists in ~/Documents/gravador-de-calls.

4. The speech recognition model: a 1.6 GB download, the longest step.
   Commands:
       mkdir -p "$HOME/Library/Application Support/gravador-de-calls/modelos"
       curl -L --fail -o "$HOME/Library/Application Support/gravador-de-calls/modelos/ggml-large-v3-turbo.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
       stat -f%z "$HOME/Library/Application Support/gravador-de-calls/modelos/ggml-large-v3-turbo.bin"
   Check: the downloaded file is exactly 1624555275 bytes. A truncated file makes whisper fail without explaining why.

5. The link between the Chrome extension and the program that transcribes.
   Commands:
       cd ~/Documents/gravador-de-calls
       npm run instalar -- --id kpbjnbedejcbakdjacjmhaofidooddjp
   Check: the command finished without errors and the id kpbjnbedejcbakdjacjmhaofidooddjp appears in the host manifest it wrote.

6. A test call, spoken by the Mac itself, to prove transcription works end to end.
   Commands:
       cd ~/Documents/gravador-de-calls
       npm run teste:transcricao-real
   Check: the test finished saying it passed. It runs in a temporary folder and never touches my recordings.

What is left for me at the end

1. Choose the recordings folder in the extension settings.
2. Leave the option "Your computer" selected under Transcription, in the extension settings.
```
