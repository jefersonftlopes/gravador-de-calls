// dom: nenhum objeto da call legível (o Teams mudou os internos). O adaptador decide só pelo DOM
// e pelo PC: controle da call na tela, sem marcador de pré-join ou lobby, e PC conectado com áudio.
// Participantes pelo painel de pessoas ([data-cid="roster-participant"], quem está no lobby fica
// de fora). Ao desligar, a barra some e o PC fecha.
ui.opts.objeto = 'nenhum';
ui.opts.titulo = 'Revisão de contrato';
ui.opts.fim = 'dom';
ui.prejoin();
