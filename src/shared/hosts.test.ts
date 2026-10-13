// Hosts das calls (Emenda 17): a fonte única e cada parte que decide pelo host. Todo host pelo
// proxy do Defender for Cloud Apps (.mcas.ms, .mcas-gov.us, .mcas-gov.ms) tem de cair no mesmo
// adaptador, na mesma plataforma e no mesmo badge que o host simples.
import { describe, expect, it } from 'vitest'
import { CALL_MATCHES as MANIFEST_MATCHES } from '../../manifest.config'
import { isCallHostUrl, isCallTabUrl } from '../background/badge'
import { pickAdapter } from '../main-world/install'
import { meetAdapter, meetCode } from '../main-world/platforms/meet'
import { teamsAdapter, teamsIds } from '../main-world/platforms/teams'
import { CALL_HOSTS, CALL_MATCHES, PROXY_SUFFIXES, hostsOf, platformOfCallUrl, platformOfHost } from './hosts'

const PLAIN_TEAMS = ['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com']
const PROXIED_TEAMS = PLAIN_TEAMS.flatMap((h) => [`${h}.mcas.ms`, `${h}.mcas-gov.us`, `${h}.mcas-gov.ms`])
const PROXIED_MEET = ['meet.google.com.mcas.ms', 'meet.google.com.mcas-gov.us', 'meet.google.com.mcas-gov.ms']

describe('fonte única dos hosts das calls', () => {
  it('os simples e, para cada um, os três sufixos do proxy; o host do achado de uso real está lá', () => {
    expect(PROXY_SUFFIXES).toEqual(['.mcas.ms', '.mcas-gov.us', '.mcas-gov.ms'])
    expect(hostsOf('meet')).toEqual(['meet.google.com', ...PROXIED_MEET])
    expect([...hostsOf('teams')].sort()).toEqual([...PLAIN_TEAMS, ...PROXIED_TEAMS].sort())
    expect(CALL_HOSTS).toHaveLength(16)
    expect(new Set(CALL_HOSTS).size).toBe(16)
    expect(CALL_HOSTS).toContain('teams.cloud.microsoft.mcas.ms')
  })

  it('o manifesto é gerado daqui (content_scripts e host_permissions)', () => {
    expect(MANIFEST_MATCHES).toEqual([...CALL_MATCHES])
    expect(CALL_MATCHES).toContain('https://teams.cloud.microsoft.mcas.ms/*')
    for (const m of CALL_MATCHES) expect(m).toMatch(/^https:\/\/[a-z0-9.-]+\/\*$/)
  })

  it('platformOfHost: com e sem proxy, maiúsculas e ponto final; nada parecido passa', () => {
    for (const h of ['meet.google.com', ...PROXIED_MEET]) expect(platformOfHost(h), h).toBe('meet')
    for (const h of [...PLAIN_TEAMS, ...PROXIED_TEAMS]) expect(platformOfHost(h), h).toBe('teams')
    expect(platformOfHost('TEAMS.Cloud.Microsoft.MCAS.MS')).toBe('teams')
    expect(platformOfHost('teams.cloud.microsoft.mcas.ms.')).toBe('teams')
    for (const h of ['mcas.ms', 'evil.mcas.ms', 'teams.cloud.microsoft.cas.ms', 'teams.cloud.microsoft.mcas.ms.evil.com', 'meet.google.com.evil.com', 'xteams.live.com', '', null, undefined])
      expect(platformOfHost(h), String(h)).toBeNull()
    expect(platformOfCallUrl('https://teams.cloud.microsoft.mcas.ms/v2/')).toBe('teams')
    expect(platformOfCallUrl('http://teams.cloud.microsoft.mcas.ms/')).toBeNull()
    expect(platformOfCallUrl('lixo')).toBeNull()
  })

  it('todo host pelo proxy escolhe o mesmo adaptador do host simples', () => {
    for (const h of ['meet.google.com', ...PROXIED_MEET]) expect(pickAdapter(h), h).toBe(meetAdapter)
    for (const h of [...PLAIN_TEAMS, ...PROXIED_TEAMS]) expect(pickAdapter(h), h).toBe(teamsAdapter)
    expect(pickAdapter('example.com')).toBeNull()
  })

  it('o adaptador trata o host pelo proxy como o simples: gate da URL, código e IDs', () => {
    for (const h of PROXIED_TEAMS) expect(teamsAdapter.matchesUrl({ hostname: h } as Location), h).toBe(true)
    expect(teamsAdapter.matchesUrl({ hostname: 'example.com' } as Location)).toBe(false)
    for (const h of PROXIED_MEET) {
      expect(meetCode({ hostname: h, pathname: '/abc-defg-hij' }), h).toBe('abc-defg-hij')
      expect(meetAdapter.matchesUrl({ hostname: h, pathname: '/abc-defg-hij' } as Location), h).toBe(true)
    }
    const thread = '19:meeting_UGxhbmVqYW1lbnRvLWZhbHNv@thread.v2'
    const plain = teamsIds(`https://teams.cloud.microsoft/l/meetup-join/${encodeURIComponent(thread)}/0`, null)
    const proxied = teamsIds(`https://teams.cloud.microsoft.mcas.ms/l/meetup-join/${encodeURIComponent(thread)}/0`, null)
    expect(proxied).toEqual(plain)
    expect(proxied.meetingId).toBe(thread)
    expect(teamsIds('https://teams.microsoft.com.mcas.ms/meet/1234567890123?p=x', null).code).toBe('1234567890123')
  })

  it('badge: a aba pelo proxy é aba de call (Teams em qualquer caminho, Meet só com o código)', () => {
    for (const h of PROXIED_TEAMS) {
      expect(isCallHostUrl(`https://${h}/`), h).toBe(true)
      expect(isCallTabUrl(`https://${h}/v2/`), h).toBe(true)
    }
    for (const h of PROXIED_MEET) {
      expect(isCallTabUrl(`https://${h}/abc-defg-hij`), h).toBe(true)
      expect(isCallTabUrl(`https://${h}/`), h).toBe(false)
    }
    expect(isCallHostUrl('https://teams.cloud.microsoft.mcas.ms.evil.com/')).toBe(false)
  })
})
