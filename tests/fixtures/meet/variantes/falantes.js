// falantes: Meet com o que a linha do tempo dos falantes lê (Emenda 18), sem nada a clicar:
// - ao entrar, a página busca a lista de participantes no SyncMeetingSpaceCollections (rota de
//   ../roster.ts) e lê a resposta ela mesma (fx.rosterBuscada; o corpo tem de chegar inteiro à
//   página mesmo com a extensão lendo uma cópia);
// - a página cria o canal 'dcrpc' antes da oferta (o Meet o cria localmente); o 'collections' vem
//   do outro lado (o participante remoto abre, ../../peer/variantes/canais.js com ?abrir=collections);
// - só o seu bloco [data-participant-id] ([data-self-name]), sem medidor de voz: os nomes dos
//   outros têm de vir da rede;
// - o microfone falso começa desligado e fx.roteiroMic([{ em, on }]) liga e desliga a sua fala;
// - com ?marca=nao, o seu bloco vem sem o [data-self-name], como numa daily real (13/10/2026): o
//   seu nome tem de vir da roster (Emenda 20).
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
sala.opts.beforeOffer = (pc) => { fx.dcrpc = pc.createDataChannel('dcrpc'); };
const semMarca = new URLSearchParams(location.search).get('marca') === 'nao';
const tile = (id, name, self) =>
  ui.el('div', { 'data-participant-id': id }, ui.el('span', { class: 'notranslate' }, name), ...(self && !semMarca ? [ui.el('div', { 'data-self-name': name })] : []));
sala.micReady.then(() => {
  for (const t of sala.mic().getAudioTracks()) t.enabled = false;
  fx.micDesligado = true;
});
fx.roteiroMic = (plano) => {
  for (const m of plano) setTimeout(() => { for (const t of sala.mic().getAudioTracks()) t.enabled = m.on; }, Math.max(0, m.em - Date.now()));
};
ui.$('participar').addEventListener('click', () => {
  ui.enterCall();
  ui.palco.append(ui.el('div', { id: 'grade' }, tile('spaces/sala1/devices/1', 'Alex Lima', true)));
  fetch('/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections', { method: 'POST', body: 'x' })
    .then((r) => r.text())
    .then((t) => { fx.rosterBuscada = t.length > 0; })
    .catch((e) => fx.errors.push('roster: ' + e.message));
  sala.start();
});
