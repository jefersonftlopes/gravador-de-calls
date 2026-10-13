// metadados: igual à "normal" no áudio, com o que o Meet mostra de dados da call.
// - Título atrasado: o elemento do título mostra o código e a aba fica "Meet - <código>" (nenhum
//   dos dois serve de título). fx.meioDaCall() mostra o título; fx.fimDaCall() tira o elemento
//   (outro layout): só uma leitura no meio da call vê o título.
// - Blocos [data-participant-id]: o próprio (com [data-self-name]), a Ana e três rótulos que não
//   são gente (efeitos, "Google Participant (", spaces/devices). fx.meioDaCall() põe o Bruno;
//   fx.fimDaCall() tira o Bruno e põe a Carla (o Meet só mostra quem está na tela: os nomes se
//   acumulam, e o Bruno só aparece para uma leitura no meio da call).
// - Fins sem o cabeçalho de saída: fx.fecharPc() fecha o PC (pc.close(), sem tela de saída);
//   fx.reconectar() fecha o PC e abre outro 2 s depois (mais que um ciclo de 1 s, menos que a
//   carência de 5 s); fx.sumirLegenda() tira o ícone de legenda (janela estreita: o Meet leva o
//   ícone para o menu "mais opções"; a call continua); fx.sumirSair() tira o botão de sair.
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
const code = location.pathname.slice(1);
const tile = (id, name, self) =>
  ui.el('div', { 'data-participant-id': id }, ui.el('span', { class: 'notranslate' }, name), ...(self ? [ui.el('div', { 'data-self-name': name })] : []));
let grade = null;
ui.$('participar').addEventListener('click', () => {
  ui.enterCall();
  document.querySelector('[jsname="NeC6gb"]').textContent = code;
  document.title = 'Meet - ' + code;
  grade = ui.el('div', { id: 'grade' },
    tile('spaces/abc/devices/1', 'Alex Lima', true),
    tile('spaces/abc/devices/2', 'Ana Souza'),
    tile('spaces/abc/devices/4', 'visual_effectsPlanos de fundo e efeitos'),
    tile('spaces/abc/devices/5', 'Google Participant (spaces/abc/devices/5)'),
    tile('spaces/abc/devices/6', 'spaces/abc/devices/6'),
  );
  ui.palco.append(grade);
  sala.start();
});
fx.meioDaCall = () => {
  document.querySelector('[jsname="NeC6gb"]').textContent = 'Revisão de arquitetura';
  grade.append(tile('spaces/abc/devices/3', 'Bruno Lima'));
};
fx.fimDaCall = () => {
  document.querySelector('[jsname="NeC6gb"]').remove();
  grade.querySelector('[data-participant-id="spaces/abc/devices/3"]').remove();
  grade.append(tile('spaces/abc/devices/7', 'Carla Dias'));
};
fx.fecharPc = () => {
  fx.fechouEm = Date.now();
  sala.leave();
};
fx.reconectar = () => {
  fx.reconectouEm = Date.now();
  sala.leave();
  setTimeout(() => sala.start(), 2000);
};
fx.sumirLegenda = () => {
  fx.sumiuEm = Date.now();
  for (const i of Array.from(document.querySelectorAll('.google-symbols'))) if (/^closed_caption/.test(i.textContent)) i.closest('button').remove();
};
fx.sumirSair = () => {
  fx.sumiuSairEm = Date.now();
  for (const b of Array.from(document.querySelectorAll('button[jsname="CQylAd"]'))) b.remove();
};
