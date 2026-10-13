// ffmpeg e whisper-cli FALSOS (scripts sh) para os testes da transcrição (Emenda 13). Nenhum
// teste automático roda o whisper de verdade nem baixa modelo: o teste real fica em
// scripts/teste-transcricao-real.mjs (npm run teste:transcricao-real), fora do npm test.
//
// O comportamento é controlado por arquivos na pasta dos scripts (o helper aberto pelo Chrome não
// herda variáveis do teste):
// - fala.txt   texto do primeiro segmento (padrão: "texto falso da transcrição");
// - espera     segundos que o whisper falso dorme antes de responder;
// - falhar     se existir, o whisper falso sai com erro;
// - silencios.txt  linhas do silencedetect que o ffmpeg falso escreve no stderr (as pausas);
// - eco        se existir, o texto do primeiro segmento é o conteúdo do áudio (o ffmpeg falso só
//              copia), para o teste saber qual áudio foi transcrito;
// - chamadas.log  "inicio <pid>" e "fim <pid>" de cada whisper falso (prova de um por vez).
// - segmentos.json  se existir, é o `transcription` do JSON de saída (segmentos em tempos
//              conhecidos, para os testes dos falantes, Emenda 18); `fakeSegments` monta o arquivo.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FAKE_TEXT = 'texto falso da transcrição'

export interface FakeTools {
  dir: string
  whisperCli: string
  ffmpeg: string
  /** Um arquivo qualquer que serve de "modelo" (o whisper falso não lê). */
  model: string
  calls: string
}

const FFMPEG = `#!/bin/sh
# ffmpeg falso: copia a entrada (-i) para a saída (último argumento).
dir=$(cd "$(dirname "$0")" && pwd)
in=""; prev=""; out=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then in="$a"; fi
  prev="$a"; out="$a"
done
if [ ! -f "$in" ]; then echo "erro: entrada não existe: $in" >&2; exit 1; fi
if [ -f "$dir/silencios.txt" ]; then cat "$dir/silencios.txt" >&2; fi
cp "$in" "$out"
`

const WHISPER = `#!/bin/sh
# whisper-cli falso: escreve <-of>.json no formato do whisper.cpp 1.9 (-oj).
dir=$(cd "$(dirname "$0")" && pwd)
of=""; f=""; m=""; prev=""
for a in "$@"; do
  case "$prev" in
    -of) of="$a" ;;
    -f) f="$a" ;;
    -m) m="$a" ;;
  esac
  prev="$a"
done
echo "inicio $$" >> "$dir/chamadas.log"
if [ -f "$dir/espera" ]; then sleep "$(cat "$dir/espera")"; fi
if [ -f "$dir/falhar" ]; then echo "whisper_init: error: modelo corrompido" >&2; echo "fim $$" >> "$dir/chamadas.log"; exit 3; fi
if [ ! -f "$f" ]; then echo "error: sem áudio $f" >&2; exit 2; fi
texto="${FAKE_TEXT}"
if [ -f "$dir/fala.txt" ]; then texto=$(cat "$dir/fala.txt"); fi
if [ -f "$dir/eco" ]; then texto=$(cat "$f"); fi
if [ -f "$dir/segmentos.json" ]; then
  printf '{"model":{"type":"small"},"params":{"model":"%s","language":"auto"},"result":{"language":"pt"},"transcription":' "$m" > "$of.json"
  cat "$dir/segmentos.json" >> "$of.json"
  printf '}' >> "$of.json"
  echo "fim $$" >> "$dir/chamadas.log"
  exit 0
fi
cat > "$of.json" <<FIM
{"model":{"type":"small"},"params":{"model":"$m","language":"auto"},"result":{"language":"pt"},"transcription":[{"timestamps":{"from":"00:00:00,000","to":"00:00:02,500"},"offsets":{"from":0,"to":2500},"text":" $texto"},{"timestamps":{"from":"00:00:02,600","to":"00:00:04,000"},"offsets":{"from":2600,"to":4000},"text":" segunda frase."}]}
FIM
echo "fim $$" >> "$dir/chamadas.log"
`

export function makeFakeTools(dir: string): FakeTools {
  mkdirSync(dir, { recursive: true })
  const whisperCli = join(dir, 'whisper-cli')
  const ffmpeg = join(dir, 'ffmpeg')
  const model = join(dir, 'ggml-small.bin')
  writeFileSync(whisperCli, WHISPER)
  writeFileSync(ffmpeg, FFMPEG)
  chmodSync(whisperCli, 0o755)
  chmodSync(ffmpeg, 0o755)
  writeFileSync(model, 'modelo falso')
  return { dir, whisperCli, ffmpeg, model, calls: join(dir, 'chamadas.log') }
}

/**
 * O `transcription` do whisper.cpp com estes segmentos (segundos), para o whisper falso escrever
 * (arquivo segmentos.json na pasta dos programas).
 */
export function fakeSegments(tools: FakeTools, segments: Array<[number, number, string]>): void {
  const toMs = (s: number) => Math.round(s * 1000)
  const transcription = segments.map(([from, to, text]) => ({ offsets: { from: toMs(from), to: toMs(to) }, text: ` ${text}` }))
  writeFileSync(join(tools.dir, 'segmentos.json'), JSON.stringify(transcription))
}

/** Seção `transcricao` do config.json apontando para os programas falsos. */
export function fakeTranscriptionConfig(tools: FakeTools, extra: Record<string, unknown> = {}) {
  return { ativa: true, motor: 'whisper-cpp', modelo: tools.model, idioma: 'auto', whisperCli: tools.whisperCli, ffmpeg: tools.ffmpeg, ...extra }
}
