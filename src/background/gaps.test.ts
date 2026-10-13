import { describe, expect, it } from 'vitest'
import { closeTrailingGap } from './gaps'

describe('closeTrailingGap', () => {
  it('registra os chunks anunciados no session:end que nunca chegaram', () => {
    expect(closeTrailingGap([], 3, 5)).toEqual([{ fromSeq: 3, toSeq: 5 }])
    expect(closeTrailingGap([{ fromSeq: 1, toSeq: 1 }], 4, 4)).toEqual([
      { fromSeq: 1, toSeq: 1 },
      { fromSeq: 4, toSeq: 4 },
    ])
  })

  it('não muda nada quando todos chegaram, sem lastSeq ou sem chunks', () => {
    expect(closeTrailingGap([], 6, 5)).toEqual([])
    expect(closeTrailingGap([], 0, null)).toEqual([])
    expect(closeTrailingGap([], 0, -1)).toEqual([])
  })

  it('não duplica numa segunda finalização e não altera a lista recebida', () => {
    const gaps = [{ fromSeq: 2, toSeq: 3 }]
    expect(closeTrailingGap(gaps, 2, 3)).toEqual(gaps)
    closeTrailingGap(gaps, 4, 9)
    expect(gaps).toEqual([{ fromSeq: 2, toSeq: 3 }])
  })
})
