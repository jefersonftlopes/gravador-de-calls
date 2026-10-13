// vitrine: igual à "normal" no áudio, com título e participantes fictícios vindos da URL, para as
// capturas da Chrome Web Store (tests/capturas). `titulo=<texto>` vira o título da call e
// `nomes=<a>,<b>` os blocos de participante (o primeiro é o próprio).
sala.opts.onRemote = (track, streams) => ui.playRemote(track, streams);
ui.$('participar').addEventListener('click', () => {
  ui.enterCall();
  const titulo = q.get('titulo');
  if (titulo) {
    document.querySelector('[jsname="NeC6gb"]').textContent = titulo;
    document.title = 'Meet - ' + titulo;
  }
  const nomes = (q.get('nomes') || '').split(',').filter(Boolean);
  ui.palco.append(
    ui.el('div', { id: 'grade' }, ...nomes.map((nome, i) =>
      ui.el('div', { 'data-participant-id': 'spaces/vitrine/devices/' + (i + 1) },
        ui.el('span', { class: 'notranslate' }, nome),
        ...(i === 0 ? [ui.el('div', { 'data-self-name': nome })] : []),
      ),
    )),
  );
  sala.start();
});
