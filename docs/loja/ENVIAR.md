# Enviar à Chrome Web Store: passo a passo

Roteiro para enviar a versão 0.3.0 pelo painel do desenvolvedor da Chrome Web Store. Nada daqui foi enviado: quem envia é você. Os textos para colar estão em [listagem-en.md](./listagem-en.md) e [listagem-pt_BR.md](./listagem-pt_BR.md); as imagens, em [capturas/](./capturas) e nos `promo-440x280*.png` desta pasta.

## 0. Antes de abrir o painel

1. Gere o pacote a partir da `main` limpa:

   ```bash
   npm run empacotar
   ```

   Sai `artifacts/gravador-de-calls-0.3.0.zip` (cerca de 196 KB, 30 arquivos). O script já confere que o manifesto não tem `key`, tem `homepage_url`, tem as duas línguas e nenhum gancho de teste.
2. Confira que o site está no ar (é o link da política que vai no painel):
   - https://gravador-de-calls.vercel.app/en/privacy
   - https://gravador-de-calls.vercel.app/privacidade
3. Conta de desenvolvedor: em https://chrome.google.com/webstore/devconsole, entre com a conta Google que vai ser a dona do item. Na primeira vez, o painel cobra a taxa única de registro e pede:
   - **Nome do editor (publisher):** `Enkode`.
   - **E-mail de contato:** `jefersonftlopes@gmail.com` (o mesmo das políticas de privacidade). O painel manda um e-mail de verificação: confirme antes de enviar, senão o envio fica bloqueado.
   - **Declaração de comerciante (trader) da União Europeia:** a extensão é gratuita e não vende nada; responda conforme a sua situação. Se declarar comerciante, o painel pede endereço e telefone públicos.

## 1. Criar o item e subir o zip

1. Painel > **Items** > **New item** (Adicionar novo item).
2. Escolha `artifacts/gravador-de-calls-0.3.0.zip` e envie.
3. O item é criado como rascunho e **já ganha o ID definitivo da loja** (aparece no topo da página do item e na URL). Anote: ele serve para o helper (seção 7).

## 2. Aba "Store listing" (Página na loja)

O painel mostra um seletor de idioma com as línguas do pacote (`en`, padrão, e `pt_BR`). Preencha as duas. O **resumo** que aparece na loja não tem campo no painel: é a `description` do manifesto, que vem de `public/_locales/<idioma>/messages.json`.

### 2.1 Inglês (padrão)

| Campo | O que vai |
|---|---|
| Description | O bloco "Detailed description" de [listagem-en.md](./listagem-en.md) (texto puro, como está). |
| Category | **Productivity > Communication** (segunda opção: Productivity > Tools). |
| Language | English. |
| Store icon (128x128) | `public/icons/icon128.png`. |
| Screenshots (1280x800) | Na ordem: `capturas/en/1-gravando.png`, `2-recentes.png`, `3-volume.png`, `4-opcoes.png`, `5-aviso.png`. |
| Small promo tile (440x280) | `promo-440x280.png`. |
| Marquee promo tile | deixe vazio (opcional). |
| Homepage URL | `https://gravador-de-calls.vercel.app/en` |
| Support URL | `https://gravador-de-calls.vercel.app/en` |
| Official URL | deixe vazio (exige verificar um domínio próprio no Search Console). |

### 2.2 Português (Brasil)

Troque o seletor de idioma para **Português (Brasil)**:

| Campo | O que vai |
|---|---|
| Descrição | O bloco "Descrição detalhada" de [listagem-pt_BR.md](./listagem-pt_BR.md). |
| Capturas | `capturas/pt-BR/1-gravando.png`, `2-recentes.png`, `3-volume.png`, `4-opcoes.png`, `5-aviso.png`. |
| Bloco promocional pequeno | `promo-440x280-pt_BR.png`. |

Categoria, ícone e URLs valem para todas as línguas.

## 3. Aba "Privacy" (Privacidade)

Esta aba é uma só para todas as línguas e quem lê é o revisor: cole os textos em inglês de [listagem-en.md](./listagem-en.md).

1. **Single purpose description:** o bloco "Single purpose".
2. **Permission justification:** um campo por permissão. Cole a linha correspondente da tabela "Permission justifications" (as nove permissões: `storage`, `unlimitedStorage`, `offscreen`, `nativeMessaging`, `downloads`, `notifications`, `tabCapture`, `activeTab`, `alarms`) e, no campo de **host permission**, a última linha da tabela (inclui a explicação do script no MAIN world).
   - **0.5.0 (Emenda 21):** há uma permissão de host **opcional**, `https://api.openai.com/*`, da transcrição por API. O painel costuma pedir a justificativa dela no mesmo campo de host permission: cole também a linha `Optional access to https://api.openai.com/*` da tabela.
3. **Are you using remote code?** **No, I am not using remote code.** Se o revisor perguntar pelo `Function(` que aparece no pacote: é o teste interno do zod, que não roda (o `jitless` está ligado; explicação em `docs/LOJA.md`, seção 2).
4. **Data usage:** marque **Personally identifiable information**, **Personal communications** e **Website content**. Deixe as outras desmarcadas (o motivo de cada uma está na tabela da listagem).
   - **0.5.0:** as caixas continuam as mesmas, mas o que elas significam mudou: com a transcrição por API ligada pelo usuário, o áudio da call ("Personal communications") é **enviado** para o provedor que ele escolher. A seção "Práticas de dados" da listagem explica por que as três certificações continuam verdadeiras, e a política de privacidade ganhou a seção 7-A. Se o revisor perguntar, a resposta curta é: desligada por padrão, por perfil, com permissão de host opcional pedida na hora, chave do próprio usuário, e só o áudio sai.
5. Marque as **três certificações** (não vende nem transfere dados; não usa para outro fim; não usa para crédito).
6. **Privacy policy URL:** `https://gravador-de-calls.vercel.app/en/privacy`

## 4. Instruções de teste para o revisor

No campo **Test instructions** (aba "Test instructions", quando o painel mostrar; se não houver, nas notas do envio), cole o bloco "Test instructions for the reviewer" de [listagem-en.md](./listagem-en.md). Ele diz que não precisa de conta nem do helper, começa pelo aviso da primeira execução ("I understand"), testa o modo aba sem reunião, o volume desta aba e a gravação automática numa reunião do Meet com um segundo aparelho.

## 5. Aba "Distribution" (Distribuição)

| Campo | Recomendação |
|---|---|
| Visibility | **Unlisted** na primeira versão: só quem tem o link instala, e você usa a cópia da loja nas suas calls por uma ou duas semanas antes de abrir. Depois troque para **Public** no mesmo painel (a loja pode fazer uma revisão rápida da mudança, sem pacote novo). Public desde o início também serve, se preferir; Private só para contas de um domínio Google Workspace. |
| Regions | All regions. |

## 6. Enviar para revisão

1. Botão **Submit for review**.
2. Na janela de confirmação, **desmarque "Publish automatically after approval"** (publicar sozinho depois da aprovação). Assim, aprovado, o item espera você clicar em **Publish**, e você escolhe a hora.
3. A revisão costuma levar de alguns dias a algumas semanas (extensão que lida com áudio e com `nativeMessaging` tende a demorar mais). O status aparece no painel e chega por e-mail.
4. Se reprovar, o e-mail diz a regra. Os riscos já mapeados e a saída de cada um:
   - **Propósito único:** o volume por aba funciona em qualquer site. Saída: limitar o volume às abas de call ou tirar do pacote da loja (anotado na listagem).
   - **Permissão sem uso aparente:** `nativeMessaging` serve ao helper, que a loja ainda não distribui. Saída: responder com a justificativa; se insistirem, tirar a permissão do pacote da loja (a pasta escolhida e a transcrição ficam só no build de desenvolvimento).

Qualquer mudança depois do envio exige versão nova: suba a versão em `package.json`, rode `npm run empacotar` e envie o zip novo na aba **Package**.

### 0.3.1: hosts novos com a 0.3.0 ainda em revisão (08/10/2026)

A 0.3.1 acrescenta permissões de host (o Teams e o Meet pelo proxy do Microsoft Defender for Cloud Apps: os quatro hosts das calls com `.mcas.ms`, `.mcas-gov.us` e `.mcas-gov.ms` no fim; Emenda 17). Permissão nova significa revisão nova, e a revisão olha o pacote inteiro:

1. Rode `npm run empacotar`: sai `artifacts/gravador-de-calls-0.3.1.zip`.
2. No painel, se a 0.3.0 ainda estiver em revisão, **Cancel review** (cancelar a revisão) e envie o zip da 0.3.1 na aba **Package**. Se a 0.3.0 já tiver sido aprovada, envie a 0.3.1 como atualização.
3. Na aba **Privacy**, no campo de **host permission**, cole de novo a última linha da tabela de [listagem-en.md](./listagem-en.md): ela agora lista os dezesseis hosts e explica os do proxy.
4. A política de privacidade já fala dos hosts do proxy (site publicado em 08/10/2026).

Numa extensão já publicada, o Chrome desliga a cópia instalada que ganha uma permissão de host nova até o usuário aceitar. Como a 0.3.0 não foi publicada, nenhum usuário passa por isso.

## 7. Depois da aprovação

### O ID da loja e o helper

A cópia da loja tem um ID diferente do da cópia de desenvolvimento (o pacote vai sem a chave; a loja dá o ID dela). Quem usa o helper (você, por enquanto) precisa liberar esse ID no manifesto do native messaging:

```bash
npm run instalar -- --id <ID da loja>
```

O ID de desenvolvimento continua entrando sempre; o `--id` só acrescenta o da loja em `allowed_origins`. Rode de novo sempre que reinstalar o helper (sem o `--id`, o ID da loja sai da lista). Depois, recarregue a cópia da loja em `chrome://extensions` ou reinicie o Chrome, e confira no popup que a linha de baixo mostra o helper (e não "Salvando em Downloads").

### Cópia de desenvolvimento e cópia da loja juntas

- As duas podem ficar instaladas no mesmo Chrome, porque têm IDs diferentes, mas **não deixe as duas ligadas no mesmo perfil**: cada uma grava a call sozinha e você teria duas gravações de cada call (e dois avisos, dois ícones REC).
- Uso recomendado: a cópia da loja ligada nos perfis de trabalho do dia a dia; a de desenvolvimento desligada em `chrome://extensions` (ou só num perfil de testes), ligada quando for testar uma mudança antes de enviar a próxima versão.
- Configurações e últimas gravações são de cada cópia (cada ID tem o seu `chrome.storage`): na cópia da loja, confirme o aviso de novo e dê o nome do perfil de novo nas configurações. A pasta do helper é a mesma para as duas.
- `npm run publicar` atualiza só a cópia de desenvolvimento. A da loja se atualiza sozinha quando você publica uma versão nova pelo painel.

### Depois de publicar

- Troque o link provisório da loja no site (`site/index.html` e `site/en/index.html`, comentário `LOJA: trocar pelo link do item`) pelo link do item e publique o site (`cd site && vercel deploy --prod --scope <seu-time>`).
- A verificação numa call real com outra pessoa falando (ESPEC, "Em aberto") continua valendo: faça na cópia da loja na primeira semana, enquanto ela está como Unlisted.

## Item criado (08/10/2026)

- ID da extensão na loja: `kpbjnbedejcbakdjacjmhaofidooddjp` (o da cópia de desenvolvimento continua `jelngomonmgghmkhabgmkpjipdipacpj`).
- O helper já aceita as duas: `npm run instalar -- --id kpbjnbedejcbakdjacjmhaofidooddjp` foi rodado, e o `allowed_origins` do manifesto do host tem os dois IDs. Rode de novo com o mesmo `--id` sempre que reinstalar o helper.
- Link público, que só funciona depois da aprovação: https://chromewebstore.google.com/detail/kpbjnbedejcbakdjacjmhaofidooddjp (trocar no site o comentário "LOJA: trocar pelo link do item").

## Publicada (09/10/2026)

- A 0.3.0 foi aprovada e está publicada, pública: https://chromewebstore.google.com/detail/gravador-de-calls/kpbjnbedejcbakdjacjmhaofidooddjp
- O botão do site (`site/index.html` e `site/en/index.html`) aponta para esse link, e o site foi publicado de novo.
- Próximo envio: a 0.3.1 (`artifacts/gravador-de-calls-0.3.1.zip`), que acrescenta os endereços `.mcas.ms` às permissões de site. Por isso ela passa por revisão de novo, e quem já tem a extensão precisa aceitar as permissões novas na atualização.
