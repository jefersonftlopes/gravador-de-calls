// normal: Teams v2 com conta (objeto da call em window.msteamscalling). O título vem do cabeçalho
// do pré-join, que some na call (o document.title na call fica a casca "Microsoft Teams meeting").
// Pré-join -> lobby (estado 10, barra com #hangup-button, PC conectado e áudio tocando) ->
// admitido (estado 3) -> espera (4) e de volta -> desligar (6 e depois 7).
ui.opts.objeto = 'v2';
ui.opts.fim = 'estado';
ui.prejoin();
