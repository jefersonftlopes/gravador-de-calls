// Leitor mínimo de protobuf (Emenda 18), sem esquema e sem dependência: o Meet manda a roster e a
// flag de fala por canais de dados com protobuf de formato não documentado (engenharia reversa do
// attendee e do Meeting-BaaS, docs/pesquisa/falantes-2026-10-09.md). Nada aqui lança: uma mensagem
// que não é protobuf vira null.
//
// A busca é crua (como o harvestDeviceMappings do Meeting-BaaS): cada campo de bytes é tentado
// como submensagem em qualquer profundidade, porque a profundidade dos envelopes muda entre
// versões do Meet e um decodificador por esquema perde registros.

export interface PbField {
  no: number
  /** 0 varint, 1 fixo de 64 bits, 2 bytes, 5 fixo de 32 bits. */
  wire: number
  /** varint ou fixo (como número; acima de 2^53 perde precisão, o que basta aqui). */
  num?: number
  bytes?: Uint8Array
}

const MAX_FIELDS = 20000

/** Lê um varint a partir de `pos`; null se passar do fim ou tiver mais de 10 bytes. */
function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } | null {
  let value = 0
  let mult = 1
  for (let i = 0; i < 10; i++) {
    if (pos + i >= buf.length) return null
    const b = buf[pos + i]
    value += (b & 0x7f) * mult
    if ((b & 0x80) === 0) return { value, next: pos + i + 1 }
    mult *= 128
  }
  return null
}

/** Campos de uma mensagem; null se os bytes não forem uma mensagem protobuf bem formada. */
export function parseMessage(buf: Uint8Array): PbField[] | null {
  const out: PbField[] = []
  let pos = 0
  while (pos < buf.length) {
    if (out.length >= MAX_FIELDS) return null
    const key = readVarint(buf, pos)
    if (!key) return null
    const no = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (no < 1 || no > 536870911) return null
    pos = key.next
    if (wire === 0) {
      const v = readVarint(buf, pos)
      if (!v) return null
      out.push({ no, wire, num: v.value })
      pos = v.next
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      if (!len || len.next + len.value > buf.length) return null
      out.push({ no, wire, bytes: buf.subarray(len.next, len.next + len.value) })
      pos = len.next + len.value
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return null
      out.push({ no, wire, num: 0 })
      pos += 8
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return null
      const v = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)
      out.push({ no, wire, num: v >>> 0 })
      pos += 4
    } else return null
  }
  return out
}

let strict: TextDecoder | null = null
/** Texto UTF-8 estrito (bytes que não são UTF-8 válido viram null). */
export function utf8(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null
  try {
    strict ??= new TextDecoder('utf-8', { fatal: true })
    return strict.decode(bytes)
  } catch {
    return null
  }
}

/** Primeiro campo `no` (bytes) como texto. */
export function str(fields: readonly PbField[], no: number): string | null {
  const f = fields.find((x) => x.no === no && x.wire === 2)
  return f ? utf8(f.bytes) : null
}

/** Primeiro campo `no` como número (varint ou fixo). */
export function num(fields: readonly PbField[], no: number): number | null {
  const f = fields.find((x) => x.no === no && x.wire !== 2)
  return f?.num ?? null
}

export function has(fields: readonly PbField[], no: number): boolean {
  return fields.some((x) => x.no === no)
}

/** Primeiro campo `no` como submensagem. */
export function sub(fields: readonly PbField[], no: number): PbField[] | null {
  const f = fields.find((x) => x.no === no && x.wire === 2)
  return f?.bytes ? parseMessage(f.bytes) : null
}

/**
 * Visita a mensagem e toda submensagem que dá para ler, em qualquer profundidade (até `maxDepth`
 * e `budget` mensagens). `visit` recebe os campos de cada uma.
 */
export function walk(buf: Uint8Array, visit: (fields: PbField[]) => void, maxDepth = 12, budget = 5000): void {
  let left = budget
  const go = (b: Uint8Array, depth: number) => {
    if (left-- <= 0 || depth > maxDepth) return
    const fields = parseMessage(b)
    if (!fields) return
    visit(fields)
    for (const f of fields) if (f.wire === 2 && f.bytes && f.bytes.length > 1) go(f.bytes, depth + 1)
  }
  go(buf, 0)
}
