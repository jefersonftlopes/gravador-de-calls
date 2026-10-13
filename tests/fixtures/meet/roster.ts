// Resposta falsa do SyncMeetingSpaceCollections do Meet (Emenda 18): o texto base64 de protobuf com
// a lista de participantes (UserInfoListResponse 2.2.2 = UserInfoList), que o Meet busca ao entrar
// e mais ou menos a cada minuto. Rota a mais do launchWithExtension({ routes }), instalada depois
// das padrão (tem precedência só nesta URL).
import type { BrowserContext } from '@playwright/test'
import { rosterResponseBase64, type FakeUser } from '../../helpers/protobuf'

export const ROSTER_PATH = '/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections'

export async function installMeetRosterRoute(context: BrowserContext, users: FakeUser[]): Promise<void> {
  await context.route(
    (url) => url.hostname === 'meet.google.com' && url.pathname === ROSTER_PATH,
    (route) => route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: rosterResponseBase64(users) }),
  )
}
