// Seam "elements": o que a página toca em <audio>/<video> com srcObject (docs/ARQUITETURA.md,
// "Captura: as quatro fontes"). É o ponto que pega o Teams no caminho WASM (gerador -> destino do
// AudioContext dele -> <audio> no body) e o Meet quando ele toca outra coisa que não o receptor.
//
// - O setter de HTMLMediaElement.prototype.srcObject é embrulhado: o original roda primeiro, e o
//   elemento entra no registro (por referência fraca) e avisa o controlador (notify), que liga a
//   fonte no mixer na hora. Assim a faixa já está no mixer antes da fala começar, e a linha de
//   atraso de 1,5 s cobre o começo.
// - Varredura de `audio, video` a cada consulta (o controlador consulta a cada ~1 s): pega
//   elementos que escaparam do setter (outro realm, por exemplo).
// - Só faixas de áudio vivas e não locais (registry.isLocal). Faixa repetida em vários elementos
//   entra uma vez. O elemento pausado continua valendo: a página pode dar play depois, e a fonte
//   precisa já estar no mixer para o atraso proteger o começo.
// - Os elementos de priming do seam "receivers" usam o setter ORIGINAL e ficam fora do DOM, então
//   nunca aparecem aqui.
import type { Originals } from '../originals'
import { wrapSetter } from '../wrap'
import type { Registry } from './registry'
import type { Seam, SeamSource } from './seams'
import { audioTracksOf, trackSourceCache, usableTrack, type Log } from './seam-util'

export function installElementsSeam(orig: Originals, registry: Registry, log: Log, notify: () => void): Seam {
  const elements = new Set<WeakRef<HTMLMediaElement>>()
  const known = new WeakSet<HTMLMediaElement>()
  const sourceFor = trackSourceCache(orig, 'el')
  const Media = orig.win.HTMLMediaElement

  const remember = (el: HTMLMediaElement) => {
    if (known.has(el)) return
    known.add(el)
    elements.add(new orig.WeakRef(el))
  }

  const proto = Media?.prototype
  if (proto && orig.mediaSrcObjectSet) {
    wrapSetter<HTMLMediaElement>(
      proto,
      'srcObject',
      (el, value) => {
        if (!(el instanceof Media)) return
        remember(el)
        if (value) notify()
      },
      (e) => log('srcObject', e),
    )
  }

  const scan = () => {
    try {
      const found = orig.querySelectorAll.call(document, 'audio, video') as NodeListOf<HTMLMediaElement>
      for (const el of Array.from(found)) remember(el)
    } catch (e) {
      log('varredura de elementos', e)
    }
  }

  return {
    id: 'elements',
    sources() {
      scan()
      const out: SeamSource[] = []
      const seen = new Set<MediaStreamTrack>()
      for (const ref of elements) {
        const el = ref.deref()
        if (!el) {
          elements.delete(ref)
          continue
        }
        let src: unknown
        try {
          src = orig.mediaSrcObjectGet ? orig.mediaSrcObjectGet.call(el) : el.srcObject
        } catch {
          continue
        }
        for (const t of audioTracksOf(orig, src)) {
          if (seen.has(t) || !usableTrack(registry, t)) continue
          seen.add(t)
          out.push(sourceFor(t))
        }
      }
      return out
    },
  }
}
