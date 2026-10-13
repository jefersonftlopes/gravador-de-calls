// falantes-dom: Teams sem CSRC e sem o 'main-channel' (Emenda 18): o único sinal de quem fala é o
// indicador do bloco de vídeo, [data-tid="voice-level-stream-outline"][data-is-speaking], dentro
// do bloco [data-stream-type] com o nome em [data-tid="participant-info-nametag"]. Os blocos são
// os da Ana, do Bruno e o seu (que nunca vira falante). fx.roteiroDom([{ em, falando: [nomes] }])
// troca quem está com o indicador ligado nos instantes pedidos (Date.now()).
ui.opts.objeto = 'v2';
ui.opts.fim = 'estado';
const nomes = ['Ana Souza', 'Bruno Lima', ui.opts.voce];
const admitirPadrao = ui.admitir;
ui.admitir = () => {
  admitirPadrao();
  const blocos = nomes.map((n) =>
    ui.el('div', { 'data-stream-type': 'Video', 'data-tid': n },
      ui.el('div', { 'data-tid': 'voice-level-stream-outline', 'data-is-speaking': 'false' }),
      ui.el('span', { 'data-tid': 'participant-info-nametag' }, n)));
  ui.$('palco').append(...blocos);
};
const falando = (lista) => {
  for (const b of Array.from(document.querySelectorAll('[data-stream-type]'))) {
    b.querySelector('[data-tid="voice-level-stream-outline"]').setAttribute('data-is-speaking', String(lista.includes(b.getAttribute('data-tid'))));
  }
};
// O microfone falso fica desligado (sem a "sua fala" na call toda).
sala.micReady.then(() => {
  for (const t of sala.mic().getAudioTracks()) t.enabled = false;
  fx.micDesligado = true;
});
fx.roteiroDom = (plano) => {
  for (const m of plano) setTimeout(() => falando(m.falando), Math.max(0, m.em - Date.now()));
};
ui.prejoin();
