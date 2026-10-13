// canais: participante remoto que fala pelos canais de dados, como o servidor de mídia do Meet e do
// Teams (Emenda 18). Guarda os canais que a página da call abriu (evento 'datachannel') e abre os
// rótulos de `?abrir=a,b` do lado dele (a página recebe pelo 'datachannel', como o 'collections'
// do Meet). O teste agenda mensagens com peer.roteiro([{ em, canal, b64 | texto }]): `em` é o
// instante (Date.now(), o mesmo relógio da página) e os bytes vão em base64.
const canais = new Map();
const fila = [];
const abrir = (peer.q.get('abrir') || '').split(',').filter(Boolean);
const guardar = (ch) => {
  canais.set(ch.label, ch);
  ch.binaryType = 'arraybuffer';
  ch.addEventListener('open', despachar);
};
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function despachar() {
  for (const m of fila.splice(0)) {
    const ch = canais.get(m.canal);
    if (!ch || ch.readyState !== 'open') { fila.push(m); continue; }
    ch.send(m.texto !== undefined ? m.texto : bytes(m.b64));
    peer.fx.enviados = (peer.fx.enviados || 0) + 1;
  }
}
peer.opts.onPc = (pc) => {
  pc.addEventListener('datachannel', (e) => guardar(e.channel));
  for (const label of abrir) guardar(pc.createDataChannel(label));
};
peer.enviar = (canal, dados) => { fila.push({ canal, ...dados }); despachar(); };
peer.roteiro = (plano) => {
  for (const m of plano) setTimeout(() => peer.enviar(m.canal, m), Math.max(0, m.em - Date.now()));
  return plano.length;
};
peer.canais = () => [...canais.entries()].map(([k, v]) => [k, v.readyState]);
