// Lacunas na sequência de chunks (info.json `lacunas`). Funções puras, testadas com vitest.
import type { ChunkGap } from '../shared/protocol'

/**
 * No fim: se o session:end anunciou `lastSeq` e os chunks de `nextSeq` até ele não chegaram,
 * acrescenta essa lacuna final (sem duplicar uma já registrada). `lastSeq` -1 ou null: nada.
 */
export function closeTrailingGap(gaps: readonly ChunkGap[], nextSeq: number, lastSeq: number | null): ChunkGap[] {
  const out = [...gaps]
  if (lastSeq === null || lastSeq < 0 || nextSeq > lastSeq) return out
  if (out.some((g) => g.fromSeq === nextSeq && g.toSeq === lastSeq)) return out
  out.push({ fromSeq: nextSeq, toSeq: lastSeq })
  return out
}
