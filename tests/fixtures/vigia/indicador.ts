// Parte comum das páginas do vigia: registra, com a hora, cada texto do indicador que o vigia
// põe na página (um <div> filho do <html> com "vigia: ...", ou "auto-leave: ..." em inglês), para o teste conferir a sequência
// de leituras ("queda 1/4", "a call sumiu (2/3)"...). `text: null` quando o indicador sai.
//
// Expõe window.vigiaIndicador = [{ at, text, fixed }], onde `fixed` diz se o elemento está com
// position: fixed (o estilo vem de style.cssText, como no script). Se o teste expôs
// window.vigiaReport (page.exposeFunction), cada leitura também vai para lá: assim o teste ainda
// tem a sequência depois que o vigia fechou a aba.
export const INDICADOR_OBSERVER = `
(() => {
  const seen = window.vigiaIndicador = [];
  const push = (e) => {
    seen.push(e);
    if (typeof window.vigiaReport === 'function') window.vigiaReport(e).catch(() => {});
  };
  let last = null;
  const read = () => {
    for (const el of Array.from(document.documentElement.children)) {
      const t = el.textContent || '';
      if (el.tagName === 'DIV' && (t.startsWith('vigia: ') || t.startsWith('auto-leave: '))) {
        if (t !== last) {
          last = t;
          push({ at: Date.now(), text: t, fixed: getComputedStyle(el).position === 'fixed' });
        }
        return;
      }
    }
    if (last !== null) { last = null; push({ at: Date.now(), text: null, fixed: false }); }
  };
  new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
`
