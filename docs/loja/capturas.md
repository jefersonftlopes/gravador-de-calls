# Capturas e bloco promocional da Chrome Web Store

As imagens da listagem, nos dois idiomas, prontas em `docs/loja/capturas/<idioma>/` e `docs/loja/promo-440x280*.png`. Este arquivo diz o que cada imagem mostra, as regras que ela segue e como gerar de novo.

## Regras da loja

- **Capturas de tela:** 1280x800 (preferido) ou 640x400, PNG ou JPEG, cantos retos, sem borda nem margem em volta. De 1 a 5 por idioma; a loja deixa ter capturas próprias na listagem em português e na em inglês.
- **Bloco promocional pequeno:** 440x280, PNG ou JPEG. Produzir sempre: é a imagem que a loja usa nas vitrines e em parte das buscas.
- **Bloco de destaque (marquee):** 1400x560, opcional. Não produzir agora.
- **Ícone da loja:** 128x128, já pronto em `public/icons/icon128.png` (desenho de 96 px com 16 px de margem transparente, como a loja pede).
- PNG das capturas e dos blocos sem transparência (24 bits): o fundo transparente aparece preto ou xadrez em alguns lugares da loja.
- Nada de logotipo do Google Meet, do Microsoft Teams, do Chrome ou do Google em destaque. As páginas que aparecem nas capturas são as páginas falsas dos testes (`tests/fixtures/meet` e `tests/fixtures/teams`), que imitam o comportamento, não a marca.
- Dados fictícios: participantes com nomes genéricos (os dos testes), perfil "Trabalho", títulos como "Reunião semanal" / "Weekly sync". Nunca uma gravação, pasta ou call de verdade do autor.

## Como gerar de novo

```bash
npm run capturas    # build de desenvolvimento em dist/ e tests/capturas/capturas.spec.ts (--workers=1)
```

- Playwright com o Chrome for Testing, pelo harness dos testes (`tests/helpers/browser.ts`): perfil temporário, sem o helper (como na versão da loja), downloads numa pasta temporária. Nunca o Chrome de marca, nunca a pasta Downloads real.
- Idioma da interface pelo wrapper do harness (`-AppleLanguages` no macOS, `--lang` no resto): `pt-BR` e `en-US`.
- A call é a página falsa do Meet (`tests/fixtures/meet`, variante `vitrine`, com título e nomes fictícios) com um participante falso tocando um tom: o popup mostra "chegando áudio" de verdade, e as duas gravações são salvas de verdade antes da captura das últimas gravações.
- Cada tela real (popup aberto como página, boas-vindas, configurações) é capturada a 2x e posta num quadro de 1280x800 com o gradiente do ícone, a marca e uma legenda curta no mesmo idioma. As configurações não cabem inteiras legíveis: entram o cabeçalho e as seções pasta, gravação automática, saída automática e "Avançado" (fechado), na ordem da página.
- Usa o build de desenvolvimento porque o harness depende do ID fixo e dos ganchos de teste. A interface é a mesma do pacote da loja; a única diferença visível seria a instrução do `npm` nas configurações sem helper, que fica dentro do "Avançado" fechado, e a captura confere que ela não aparece.
- PNG de 24 bits (sem alfa), convertido pelo ffmpeg.

## As capturas (na ordem da listagem)

| Arquivo | Mostra | Legenda (pt-BR) | Legenda (en) |
|---|---|---|---|
| `1-gravando.png` | Popup com duas calls gravando ao mesmo tempo, cada uma com o tempo e "chegando áudio", o botão do modo aba e o volume desta aba. | Grava sozinho quando a call começa | Records on its own when the call starts |
| `2-recentes.png` | Popup com as últimas gravações salvas em Downloads (título, data, duração, "Mostrar no Finder"/"Show in folder"). | Tudo salvo no seu computador | Everything saved on your computer |
| `3-volume.png` | Popup com o volume desta aba em 150%. | Volume desta aba, de 0% a 200% | This tab's volume, from 0% to 200% |
| `4-opcoes.png` | Configurações sem o helper: pasta em Downloads, gravação automática por plataforma, duração mínima (30 s), saída automática desligada e "Avançado: helper local" fechado, como recurso opcional. | Você decide o que grava | You decide what gets recorded |
| `5-aviso.png` | Boas-vindas com o aviso da primeira execução e o botão "Entendi"/"I understand". | Um aviso claro antes da primeira gravação | A clear notice before the first recording |

## Bloco promocional pequeno (440x280)

`docs/loja/promo-440x280.png` (inglês, a listagem padrão) e `docs/loja/promo-440x280-pt_BR.png` (português), gerados pelo mesmo `npm run capturas`.

- Fundo no gradiente do ícone (`#3b82f6` em cima, `#1d4ed8` embaixo).
- À esquerda, o ícone em 96 px (de `assets/icone/icon.svg`, sem a margem).
- À direita, em branco: "Gravador de Calls" (negrito, cerca de 30 px) e embaixo a frase curta, cerca de 18 px:
  - pt-BR: "Cada call, a sua gravação. Tudo no seu computador."
  - en: "Every call, its own recording. All on your computer."
- Sem mais texto: a loja mostra o bloco pequeno, e letra miúda vira borrão.
- Conferir o contraste do texto branco sobre o `#1d4ed8` (6,7:1) e sobre o `#3b82f6` (3,7:1, só serve para texto grande: manter a frase de 18 px na metade de baixo, sobre o tom mais escuro).

## Conferência antes de enviar

- Abrir cada PNG e olhar: textos finais no idioma certo, nenhum dado real, nada cortado, 1280x800 exatos (`file *.png`).
- As capturas de uma listagem nunca misturam idiomas.
