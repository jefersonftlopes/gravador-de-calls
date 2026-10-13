// Regras puras do volume por aba (Emenda 14).
import { describe, expect, it } from 'vitest'
import { parseTabVolumeReq } from './protocol'
import { audibleGain, clampVolume, decideVolume, isNativeVolume, volumeEligibleUrl, volumeLabel } from './volume'

describe('volume por aba', () => {
  it('clampVolume limita a 0..2, arredonda ao centésimo e recusa o que não é número finito', () => {
    expect(clampVolume(1.5)).toBe(1.5)
    expect(clampVolume(3)).toBe(2)
    expect(clampVolume(-0.2)).toBe(0)
    expect(clampVolume(0.3000000004)).toBe(0.3)
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) expect(clampVolume(v)).toBeNull()
  })

  it('decideVolume: sem captura, só de volume e gravando', () => {
    expect(decideVolume(null, 1)).toBe('nada')
    expect(decideVolume(null, 1.5)).toBe('iniciar')
    expect(decideVolume(null, 0)).toBe('iniciar')
    expect(decideVolume('volume', 1)).toBe('parar')
    expect(decideVolume('volume', 0.3)).toBe('ajustar')
    // 100% durante uma gravação nunca para nada.
    expect(decideVolume('gravando', 1)).toBe('ajustar')
    expect(decideVolume('gravando', 0.3)).toBe('ajustar')
  })

  it('ganho que se ouve: devolução desligada cala a aba, qualquer que seja o volume', () => {
    expect(audibleGain(1.5, true)).toBe(1.5)
    expect(audibleGain(1.5, false)).toBe(0)
    expect(audibleGain(1, false)).toBe(0)
    expect(isNativeVolume(1)).toBe(true)
    expect(isNativeVolume(0.95)).toBe(false)
  })

  it('o controle aparece só em páginas http e https', () => {
    expect(volumeEligibleUrl('https://www.youtube.com/watch?v=1')).toBe(true)
    expect(volumeEligibleUrl('http://localhost:3000/')).toBe(true)
    expect(volumeEligibleUrl('https://meet.google.com/abc-defg-hij')).toBe(true)
    for (const u of ['chrome://extensions/', 'chrome-extension://abc/src/popup/index.html', 'about:blank', 'file:///tmp/a.html', '', undefined]) {
      expect(volumeEligibleUrl(u), String(u)).toBe(false)
    }
  })

  it('rótulo em porcentagem', () => {
    expect(volumeLabel(1.5)).toBe('150%')
    expect(volumeLabel(0.3)).toBe('30%')
    expect(volumeLabel(0)).toBe('0%')
  })
  it('pedido do popup validado no SW: tabId inteiro não negativo e volume número finito', () => {
    expect(parseTabVolumeReq({ t: 'ui:tab-volume-get', tabId: 7 })).toEqual({ t: 'ui:tab-volume-get', tabId: 7 })
    expect(parseTabVolumeReq({ t: 'ui:tab-volume-set', tabId: 0, volume: 1.5 })).toEqual({ t: 'ui:tab-volume-set', tabId: 0, volume: 1.5 })
    for (const tabId of [-1, 1.5, '7', null, Number.NaN]) {
      expect(parseTabVolumeReq({ t: 'ui:tab-volume-get', tabId }), `tabId ${String(tabId)}`).toBeNull()
      expect(parseTabVolumeReq({ t: 'ui:tab-volume-set', tabId, volume: 1 }), `tabId ${String(tabId)}`).toBeNull()
    }
    for (const volume of ['alto', Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(parseTabVolumeReq({ t: 'ui:tab-volume-set', tabId: 7, volume }), `volume ${String(volume)}`).toBeNull()
    }
    expect(parseTabVolumeReq({ t: 'ui:outra-coisa', tabId: 7 })).toBeNull()
  })
})
