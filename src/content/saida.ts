// Saída de som da página (Emenda 11). No Teams logado o áudio da call toca num <audio> com
// setSinkId (o fone ou o dispositivo escolhido dentro do Teams). Medido numa call real em
// 07/10/2026: com o modo aba ligado, esse caminho continua tocando e a extensão, ao devolver o som
// capturado à saída padrão, fazia o usuário ouvir em dobro. Por isso o modo aba só devolve o som
// quando nenhum elemento audível da página tem dispositivo próprio.

export interface MediaOutputLike {
  sinkId?: string
  muted: boolean
}

/** Algum elemento de mídia não mudo toca num dispositivo de saída específico? */
export function pageUsesSpecificOutput(elements: Iterable<MediaOutputLike>): boolean {
  for (const el of elements) {
    if (!el.muted && typeof el.sinkId === 'string' && el.sinkId !== '') return true
  }
  return false
}
