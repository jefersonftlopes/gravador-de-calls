// sem-audio (A/B do Meet): a faixa remota chega pelo ontrack, mas a página não a liga em nenhum
// elemento. Sem o priming do crbug 40094084 (um new Audio() mudo, fora do DOM, com a faixa), o
// WebAudio da extensão só ouviria silêncio.
sala.opts.onRemote = () => {};
ui.$('participar').addEventListener('click', () => {
  ui.enterCall();
  sala.start();
});
