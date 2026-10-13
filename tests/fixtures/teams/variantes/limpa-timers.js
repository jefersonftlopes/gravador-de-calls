// limpa-timers: como a normal, mas a página cancela todos os timers por força bruta, como o Teams
// logado faz ao carregar (medido numa call real em 07/10/2026: o setInterval que a extensão cria
// no document_start rodou uma vez e morreu). Cancela de novo logo depois de admitir, para o laço
// da arbitragem e a verificação de 1 s também morrerem no meio da gravação (Emenda 12).
const cancelarTudo = () => {
  for (let i = 1; i < 100000; i++) {
    clearInterval(i);
    clearTimeout(i);
  }
};
cancelarTudo();
ui.opts.objeto = 'v2';
ui.opts.fim = 'estado';
const admitirOriginal = ui.admitir;
ui.admitir = () => {
  admitirOriginal();
  // Depois de a extensão começar a gravar (até 5 s), mata tudo de novo.
  window.cancelarTudoDeNovo = cancelarTudo;
};
ui.prejoin();
