// sem-elemento: a reunião v2 normal, mas a página não toca o `mainAudio` em nenhum <audio>. O
// seam `elements` fica sem fonte e a gravação começa pelos receptores, onde chegam as duas
// faixas do participante (`mainAudio` com o tom principal e `dominantSpeaker-1` com o redundante).
// Só o filtro dos receptores do adaptador (filterMainAudio, Emenda 5) segura o redundante fora:
// sem ele a gravação mistura os dois e repete as palavras.
ui.opts.objeto = 'v2';
ui.opts.fim = 'estado';
ui.opts.tocarPrincipal = false;
ui.prejoin();
