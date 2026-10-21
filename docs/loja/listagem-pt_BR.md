# Listagem na Chrome Web Store: português (pt_BR)

Textos prontos para colar no painel do desenvolvedor da Chrome Web Store, na listagem em português. A versão em inglês, que é a do idioma padrão (`default_locale: "en"`), está em [listagem-en.md](./listagem-en.md). As capturas e o bloco promocional estão descritos em [capturas.md](./capturas.md).

Nada aqui foi enviado à loja: quem envia é o autor.

## Nome

```
Gravador de Calls
```

O mesmo nome nos dois idiomas (é a marca). Sem "Meet" nem "Teams" no nome: a política de marcas da loja recusa nome que sugira parceria. No manifesto ele vem de `__MSG_...__` do `_locales/pt_BR/messages.json`.

## Resumo (máximo de 132 caracteres)

```
Grava, aba por aba, só o áudio dos outros participantes das calls do Google Meet e do Microsoft Teams, no seu computador.
```

121 caracteres (contados com `[...texto].length` no Node). O painel não tem campo para ele: a loja mostra a `description` do manifesto, que é a mensagem `extDescription` de `public/_locales/pt_BR/messages.json`. Para mudar o resumo, mude a mensagem e envie um pacote novo.

## Descrição detalhada

Texto puro (a loja não aceita HTML nem Markdown; as quebras de linha e os marcadores "•" aparecem como estão).

```
O Gravador de Calls grava sozinho, aba por aba, o áudio dos outros participantes das suas calls do Google Meet e do Microsoft Teams no Chrome. Cada call vira uma gravação separada, salva no seu computador junto com os dados da call.

COMO FUNCIONA
• Quando a call começa de fato (depois da tela de entrada e da sala de espera), a gravação daquela aba começa sem clique. O ícone mostra REC na aba.
• Várias calls ao mesmo tempo, em abas diferentes, viram gravações separadas: o áudio de uma não se mistura com o da outra.
• Grava só o áudio que a página da call recebe dos outros participantes. O seu microfone nunca entra na gravação, a menos que você ligue "Gravar a minha voz" nas configurações: aí a sua voz vai para um arquivo separado, e só enquanto a página da call disser que o seu microfone está aberto ali.
• No fim da call (ao sair, quando a call termina ou quando a aba fecha), o áudio (audio.webm) e um info.json com título, data, duração e os nomes de exibição dos participantes são salvos em Downloads/Gravações de calls (Downloads/Call recordings com o Chrome em inglês), numa pasta por call.
• Se a aba ou o Chrome caírem no meio da call, o que já foi gravado não se perde: a gravação é salva como interrompida.

TAMBÉM TEM
• Modo aba: quando uma call não pega áudio, o atalho Alt+Shift+G (ou o botão do popup) grava o que a aba toca, também em outros sites.
• Volume desta aba: de 0% a 200% em qualquer aba, pelo popup, sem mudar o nível das gravações.
• Sair quando a call esvaziar (opcional, desligado por padrão): sai da call e fecha a aba quando você fica sozinho ou quando quase todos já saíram, sempre depois de salvar a gravação.
• Gravação automática que liga e desliga por plataforma. Gravações com menos de 30 segundos (ajustável) são descartadas.
• Avançado: gravar numa pasta à sua escolha e transcrever cada call no próprio computador exigem o helper local, que ainda não é distribuído pela loja. Sem ele, tudo o que está acima funciona normalmente.

PRIVACIDADE
• Sem servidor, sem conta e sem analytics. A extensão não envia nada para fora do seu computador.
• O áudio de uma call em andamento fica no armazenamento local da extensão só até ser salvo.
• Política de privacidade: https://gravador-de-calls.vercel.app/privacidade

ANTES DE GRAVAR
Gravar uma conversa pode exigir o consentimento de todos os participantes, conforme o país e o estado (no Brasil, a LGPD). Avise quem está na call: a decisão de gravar, e essa responsabilidade, são suas.

LIMITES
• Funciona no Chrome para computador (versão 120 ou mais nova), no Google Meet e no Microsoft Teams pela web, não nos aplicativos instalados. Testado no Chrome do macOS.
• Em calls grandes, o Meet só entrega ao navegador as vozes mais altas de cada momento; o que não chega ao navegador não tem como ser gravado.
• Sons da própria interface da call (bipe de entrada, notificações) podem aparecer na gravação.

Google Meet e Microsoft Teams são marcas dos seus respectivos titulares. O Gravador de Calls é uma ferramenta independente, sem afiliação, patrocínio ou endosso do Google ou da Microsoft.
```

## Categoria

**Recomendada: Produtividade > Comunicação** (na lista nova da loja, "Comunicação" fica dentro de "Produtividade", então as duas opções do pedido viram uma só). É onde estão as extensões que trabalham sobre Meet e Teams, e é a função do produto: guardar o que foi dito numa call. "Produtividade > Ferramentas" é a segunda opção, mais genérica.

## Idioma

Português (Brasil). A listagem em inglês é a do idioma padrão.

## URLs

| Campo | Valor |
|---|---|
| Página inicial (Homepage URL) | `https://gravador-de-calls.vercel.app` |
| Política de privacidade | `https://gravador-de-calls.vercel.app/privacidade` (a versão em inglês, `/en/privacy`, é a recomendada no campo único do painel; ver listagem-en.md) |
| Suporte (opcional) | `https://gravador-de-calls.vercel.app` (o contato está no rodapé) |
| URL oficial (opcional) | deixar vazio: exige verificar o domínio no Google Search Console, e `vercel.app` não é um domínio próprio |

## Propósito único

```
Gravar no computador do usuário o áudio das calls do Google Meet e do Microsoft Teams abertas no Chrome, uma gravação por aba, com só o áudio dos outros participantes e os dados da call. As funções secundárias servem a esse propósito: o modo aba é a outra forma de capturar o áudio da aba quando a gravação automática não pega som, o volume desta aba usa a mesma captura de aba para o usuário ouvir a call no volume que precisa, e a saída automática encerra a call e a gravação quando a reunião esvazia.
```

Risco a conhecer: o volume por aba funciona em qualquer site, e um revisor pode ler isso como um segundo propósito. Se a loja recusar por "propósito único", a saída é limitar o volume às abas de call ou tirá-lo da versão da loja.

## Justificativa de cada permissão

Conferida com o manifesto final da versão 0.5.0 (nove permissões, os hosts das calls e, desde a 0.5.0, a permissão de host OPCIONAL da API de transcrição; ver a seção 2 de docs/LOJA.md). `tests/unit/pacote-loja.test.ts` falha se uma permissão do manifesto faltar aqui, na listagem em inglês ou na seção 13 de uma das políticas de privacidade (`site/privacidade.html` e `site/en/privacy.html`).

O painel aceita os textos em qualquer idioma; os revisores leem inglês, então a recomendação é colar os da [listagem-en.md](./listagem-en.md). A tradução fica aqui para conferência.

| Permissão | Justificativa |
|---|---|
| `storage` | Guarda as configurações do usuário (gravação automática por plataforma, duração mínima, nome do perfil, saída automática) e o estado das gravações em andamento, para sobreviver a um reinício do service worker. Tudo local. |
| `unlimitedStorage` | O áudio de uma call em andamento fica em pedaços no IndexedDB da extensão até ser salvo, para não se perder se a aba ou o Chrome caírem. Uma call de várias horas não pode bater na cota e perder o fim. Os pedaços são apagados assim que a gravação é salva. |
| `offscreen` | O documento offscreen monta o arquivo de áudio para o download (o service worker não cria Blob URL) e, no modo aba e no volume por aba, toca o som capturado da aba para o usuário continuar ouvindo a call. |
| `nativeMessaging` | Fala com o helper local opcional (programa instalado à parte, ainda não distribuído pela loja), que grava na pasta escolhida pelo usuário e transcreve as calls no próprio computador. Sem o helper, a conexão simplesmente falha e a extensão salva em Downloads. |
| `downloads` | Salva cada gravação (audio.webm e info.json) em Downloads/Gravações de calls (Downloads/Call recordings em inglês), numa pasta por call. É o destino padrão da versão da loja. |
| `notifications` | Avisa quando uma gravação passa 60 segundos sem áudio (sugerindo o modo aba), quando uma aba de call aberta antes da instalação precisa ser recarregada, e quando uma gravação não pôde ser salva. |
| `tabCapture` | Modo aba e volume desta aba: captura o som da aba atual, só depois de um gesto do usuário (atalho Alt+Shift+G, ícone ou botão do popup), para gravar o que a aba toca ou mudar o volume dela. |
| `activeTab` | No mesmo gesto do modo aba, dá o título e a URL da aba atual quando ela não é do Meet nem do Teams, para nomear a pasta da gravação. Não dá acesso a nenhuma aba fora do gesto. |
| `alarms` | Tenta de novo, a cada minuto, salvar uma gravação que não pôde ser salva no fim (por exemplo, com o disco cheio) e recupera gravações abertas depois de uma queda do Chrome. |
| Acesso aos sites `https://meet.google.com/*`, `https://meet.google.com.mcas.ms/*`, `https://meet.google.com.mcas-gov.us/*`, `https://meet.google.com.mcas-gov.ms/*`, `https://teams.microsoft.com/*`, `https://teams.cloud.microsoft/*`, `https://teams.live.com/*`, `https://teams.microsoft.com.mcas.ms/*`, `https://teams.microsoft.com.mcas-gov.us/*`, `https://teams.microsoft.com.mcas-gov.ms/*`, `https://teams.cloud.microsoft.mcas.ms/*`, `https://teams.cloud.microsoft.mcas-gov.us/*`, `https://teams.cloud.microsoft.mcas-gov.ms/*`, `https://teams.live.com.mcas.ms/*`, `https://teams.live.com.mcas-gov.us/*`, `https://teams.live.com.mcas-gov.ms/*` | Os scripts de conteúdo rodam só nas páginas das calls: detectam quando a call começa e termina, gravam o áudio que a página recebe dos outros participantes e leem o título da call e os nomes de exibição dos participantes. O script no MAIN world, em `document_start` e em todos os frames, envolve `RTCPeerConnection` e os pontos de saída de áudio da página só para observar o áudio remoto: não muda o que essas APIs devolvem nem toca no microfone. Precisa entrar antes dos scripts da página porque o Meet e o Teams criam a conexão de áudio cedo, às vezes num iframe. Os hosts terminados em `.mcas.ms`, `.mcas-gov.us` e `.mcas-gov.ms` são as mesmas páginas do Meet e do Teams quando a empresa as abre pelo proxy de sessão do Microsoft Defender for Cloud Apps (Conditional Access App Control), que acrescenta esse sufixo ao host: a extensão faz ali exatamente o mesmo, e nada mais nesses domínios. |
| Acesso opcional a `https://api.openai.com/*` | Transcrição por API (0.5.0): com a função ligada pelo usuário, a extensão manda o arquivo de áudio da call para a API de transcrição do provedor, com a chave do próprio usuário, e recebe o texto de volta. É uma **permissão opcional**: não entra no aviso da instalação, o Chrome a pede no momento em que o usuário liga a função nas configurações, e sem ela nada é enviado. A chave fica só na máquina, num espaço próprio do armazenamento da extensão, e é usada apenas no cabeçalho de autorização. Nenhum nome de participante e nenhum outro arquivo da gravação sai do computador. Desligada por padrão, e a escolha é por perfil do Chrome. |

## Práticas de dados (aba "Privacidade" do painel)

**Código remoto:** "Não, não estou usando código remoto." Todo o JavaScript vai no pacote (Vite e crxjs), sem `eval`, sem `new Function` e sem script carregado de fora.

**Dados do usuário, quais caixas marcar.** Por padrão a extensão não envia nada para fora do computador, mas trata esses dados localmente e grava arquivos com eles. Marcar o que ela trata é a leitura transparente e combina com a política de privacidade.

**Mudou na 0.5.0 (transcrição por API).** Com essa função ligada pelo usuário, o **áudio da call é enviado** para a API do provedor que ele escolher, com a chave dele. Isso é uma transferência de "Comunicações pessoais" para um terceiro escolhido pelo usuário, dentro do propósito único do item (transcrever a call que ele acabou de gravar). O que isso muda no painel:

- a declaração "não vendo nem transfiro dados do usuário a terceiros, **fora dos casos de uso aprovados**" continua verdadeira: a transferência é para o provedor que o usuário escolheu, iniciada por ele, só para entregar a função que ele pediu;
- a política de privacidade ganhou a seção **7-A**, que diz o que sai, para quem, onde fica a chave e como desligar. A URL do campo não muda;
- a função é **desligada por padrão**, **por perfil do Chrome**, e exige uma **permissão de host opcional** que o Chrome pede na hora;
- nenhum nome de participante, nenhum dado da call e nenhum outro arquivo sai do computador: os nomes são casados com o texto depois, na própria máquina.

| Tipo de dado | Marcar? | Por quê |
|---|---|---|
| Informações de identificação pessoal | **Sim** | O `info.json` guarda os nomes de exibição dos participantes e o nome do próprio usuário, lidos da página da call. |
| Informações de saúde | Não | |
| Informações financeiras e de pagamento | Não | |
| Informações de autenticação | Não | Nenhuma senha, token ou credencial. |
| Comunicações pessoais | **Sim** | O áudio das calls é o conteúdo de uma comunicação. Com a transcrição por API ligada pelo usuário (0.5.0), esse áudio é **enviado** para a API do provedor escolhido por ele, com a chave dele. |
| Local | Não | O fuso horário do `info.json` não é localização (nada de IP ou GPS). |
| Histórico da Web | Não | A extensão não registra as páginas visitadas: só guarda a URL e o título da página da call que foi gravada, como dado daquela gravação. Se a loja questionar, marcar não muda nada no produto. |
| Atividade do usuário | Não | Sem cliques, teclas, rolagem ou monitoramento de rede. |
| Conteúdo do site | **Sim** | O título da call, o título e a URL da aba e os nomes lidos da página. |

**As três declarações** (marcar as três):

- Não vendo nem transfiro dados do usuário a terceiros, fora dos casos de uso aprovados.
- Não uso nem transfiro dados do usuário para fins não relacionados ao propósito único do item.
- Não uso nem transfiro dados do usuário para determinar a capacidade de crédito ou para fins de empréstimo.

**URL da política de privacidade:** `https://gravador-de-calls.vercel.app/en/privacy` (o campo é um só; a página em inglês tem o link para a versão em português no topo).

## Instruções de teste para o revisor

O painel tem um campo "Instruções de teste" (aba "Teste"). Colar a versão em inglês da [listagem-en.md](./listagem-en.md). A tradução:

```
Não precisa de conta, login nem do helper local. O helper é opcional e não é necessário para a revisão: sem ele, a extensão salva as gravações em Downloads/Call recordings (Downloads/Gravações de calls com o Chrome em português), e as configurações mostram a pasta escolhida e a transcrição em "Avançado: helper local" como funções opcionais que exigem o helper.

0. Primeira execução: logo depois de instalar abre uma página de boas-vindas com o aviso sobre o que é gravado e sobre o consentimento. Clique em "Entendi" no fim da página. Até lá a gravação automática fica desligada e o ícone mostra "!" (o modo aba funciona, porque sempre começa por um clique seu).

1. Modo aba, sem reunião (o jeito mais rápido de ver uma gravação):
   a. Abra qualquer página que toque áudio (por exemplo, um vídeo).
   b. Aperte Alt+Shift+G (Option+Shift+G no Mac), ou abra o popup e clique em "Gravar esta aba (modo aba)". O ícone mostra REC.
   c. Deixe tocar por pelo menos 40 segundos (gravações com menos de 30 segundos são descartadas de propósito) e aperte Alt+Shift+G de novo.
   d. Abra Downloads/Gravações de calls/<AAAA-MM>/<data e hora> - <título da aba> (Outro site)/ (em inglês: Downloads/Call recordings/.../<título da aba> (Other site)/): ali estão audio-aba.webm e info.json. O popup também mostra a gravação em "Últimas gravações".

2. Volume desta aba: na mesma página, abra o popup e mova o controle "Volume desta aba" (0% a 200%). O som muda na hora; "100%" devolve a aba ao normal.

3. Gravação automática no Google Meet (precisa de um segundo participante, que pode ser você em outro aparelho):
   a. Em meet.google.com, crie uma reunião instantânea e entre.
   b. Entre na mesma reunião por um segundo aparelho (o celular com o app do Meet, ou outro navegador com outra conta ou como convidado) e fale por mais de 30 segundos.
   c. No computador, a gravação começa sozinha quando a call começa de fato; o popup mostra a gravação com o tempo e se está chegando áudio.
   d. Saia da call. A pasta da call aparece em Downloads/Gravações de calls (ou Downloads/Call recordings) com audio.webm (só a voz do segundo aparelho, sem o microfone do computador) e info.json (título, data, duração, participantes).

4. O Microsoft Teams pela web (teams.live.com, com uma conta pessoal gratuita) funciona do mesmo jeito.

Gravar uma conversa pode exigir o consentimento de todos os participantes; a extensão é feita para o usuário gravar as próprias calls depois de avisar os participantes.
```

Os passos acima usam os textos finais da versão 0.3.0 (boas-vindas, rótulos do popup e os nomes traduzidos da pasta e do sufixo).

## Distribuição (sugestão)

- Preço: gratuito.
- Regiões: todas.
- Visibilidade: começar como **Não listado** (só quem tem o link instala) para a primeira semana de uso, e trocar para Público depois. Decisão do autor.
