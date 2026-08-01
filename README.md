# Persona Stability — Ferramenta de Anotação

Aplicação web estática (GitHub Pages) para **anotação humana** de estabilidade de persona em respostas de LLMs, desenvolvida no âmbito de uma pesquisa do **AKCIT** (Centro de Competências em Tecnologias Imersivas) da **UFG**.

> A pergunta da pesquisa: as probabilidades internas (log-probabilities, rank de token, entropia) de um modelo carregam um sinal confiável e não-redundante de *drift de persona* sob estresse conversacional?

Para validar o método automático (PersonaTrace), precisamos de **julgamento humano cego**. É isso que este app coleta.

## O que o anotador faz

Em duas etapas por item:

1. **Evidência** — vendo só a *persona* e a *resposta*, avalia (1–5) o quanto a resposta preserva a identidade da persona.
2. **Resistência** — após revelar o *contexto/ataque*, avalia (1–5) se a persona se manteve sob pressão.

O anotador **não vê** PersonaTrace, modelo gerador, nome do ataque nem notas de juízes automáticos (evita viés circular). O trabalho é **salvo automaticamente** a cada item.

## Arquitetura (100% gratuita)

```
GitHub Pages (front-end estático)  →  Apps Script (API)  →  Google Sheets (dados)
   index.html + annotate/              Code.gs            master/annotations/claims
```

| Pasta/arquivo | Função |
|---|---|
| `index.html` | Landing page (contexto + instruções) |
| `assets/` | CSS global, logo (selo), diagrama do fluxo |
| `annotate/` | A ferramenta de anotação (`index.html`, `app.js`, `styles.css`) |
| `apps-script/` | Backend (`Code.gs`) + guia de publicação (`README.md`) |
| `docs/ANOTADOR.md` | Guia do anotador (critérios congelados) |

## Segurança dos dados

- **Anti-sobrescrita**: `annotations` é *append-only*; `(session_id, row_id)` só grava na 1ª vez.
- **Anti-colisão (N-10)**: cada lote reserva 10 itens por 30 min; quem já foi anotado sai do pool.
- **Anti-sabotagem**: validação de nota (1–5), token-bound por lote, rate-limit e `LockService`.

## Publicar / configurar

1. Configure a planilha e publique o Web App seguindo **`apps-script/README.md`**.
2. Cole a URL do Web App em `annotate/app.js` (`API_URL`).
3. Ative o GitHub Pages (*Settings → Pages → main / root*).

URL pública: `https://henriquegalva0.github.io/logprob-persona-annotation/`

## Licença / uso

Uso acadêmico — AKCIT · Universidade Federal de Goiás (UFG).
