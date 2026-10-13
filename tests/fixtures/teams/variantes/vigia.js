// vigia: a reunião v2 normal com o título do painel People na tela durante a call, para o vigia
// (AC18) contar por [id^="roster-title-section"] (aria-label "Nesta reunião (N)", o seletor do
// script do usuário) enquanto a extensão grava a call. `?n=<N>` dá a contagem inicial (padrão 3) e
// `fixture.setN(n)` muda; o vigia sai pelo #hangup-button da barra, que desliga como o normal
// (estado 6 e depois 7) e grava a hora em `fixture.desligouEm`.
ui.opts.objeto = 'v2';
ui.opts.fim = 'estado';
fx.n = Number(q.get('n') || 3);
const rotulo = () => 'Nesta reunião (' + fx.n + ')';
const admitirOriginal = ui.admitir;
ui.admitir = () => {
  admitirOriginal();
  ui.app.append(ui.el('div', { id: 'roster-title-section-1', role: 'heading', 'aria-label': rotulo() }, 'Nesta reunião'));
};
fx.setN = (n) => {
  fx.n = n;
  document.getElementById('roster-title-section-1')?.setAttribute('aria-label', rotulo());
};
ui.prejoin();
