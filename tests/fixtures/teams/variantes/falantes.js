// falantes: Teams v2 com o que a linha do tempo dos falantes lê (Emenda 18). Os participantes do
// objeto da call têm as fontes de áudio de cada um: a Ana pelo `hasAudioSource(1053)`, o Bruno só
// pelos `endpoints.endpointDetails[].mediaStreams[]` (sourceId 2331), e você (o
// `localSignalingParticipant`) pela fonte 9999. A página cria o canal 'main-channel' antes da
// oferta, como o Teams; o participante remoto (../../peer/variantes/canais.js) manda por ele as
// mensagens 'dsh' do falante dominante, nos instantes que o teste agenda.
//
// O microfone falso começa desligado (track.enabled = false) e fx.roteiroMic([{ em, on }]) liga e
// desliga a "sua fala" nos instantes pedidos (Date.now()).
ui.opts.objeto = 'v2';
ui.opts.fim = 'estado';
ui.opts.participantes = [
  { id: '8:orgid:ana', displayName: 'Ana Souza', state: 3, hasAudioSource: (id) => id === 1053 },
  { id: '8:orgid:bruno', displayName: 'Bruno Lima', state: 3, endpoints: { endpointDetails: [{ mediaStreams: [{ type: 'video', sourceId: 2330 }, { type: 'audio', sourceId: 2331, direction: 'recvonly' }] }] } },
];
const ofertaPadrao = sala.opts.beforeOffer;
sala.opts.beforeOffer = (pc) => {
  ofertaPadrao(pc);
  fx.mainChannel = pc.createDataChannel('main-channel');
};
const admitirPadrao = ui.admitir;
ui.admitir = () => {
  admitirPadrao();
  ui.call.localSignalingParticipant.hasAudioSource = (id) => id === 9999;
};
sala.micReady.then(() => {
  for (const t of sala.mic().getAudioTracks()) t.enabled = false;
  fx.micDesligado = true;
});
fx.roteiroMic = (plano) => {
  for (const m of plano) setTimeout(() => { for (const t of sala.mic().getAudioTracks()) t.enabled = m.on; }, Math.max(0, m.em - Date.now()));
};
ui.prejoin();
