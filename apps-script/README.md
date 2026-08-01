# Backend gratuito — Google Sheets + Apps Script

Este guia configura o "banco de dados" e a API de anotação **sem custo**, usando apenas sua conta Google.
Tempo estimado: **15 minutos**.

---

## Visão geral

```
GitHub Pages (front-end)  →  Apps Script (API)  →  Google Sheets (dados)
     HTML/JS estático         Code.gs            master / annotations / claims
```

- **master**: sua base original (imutável para os anotadores).
- **annotations**: onde cada nota é gravada (append-only).
- **claims**: reservas temporárias de lotes (para o sistema N-10).

---

## Passo 1 — Criar a planilha

1. Abra <https://sheets.new> e nomeie como **Persona Annotation DB**.
2. Crie **3 abas** com exatamente estes nomes:
   - `master`
   - `annotations`
   - `claims`

### Aba `master`
Na **linha 1** (cabeçalho), coloque:

| A | B | C | D |
|---|---|---|---|
| row_id | persona | ataque | resposta |

Importe o CSV `persona_attack_response.csv` gerando a coluna `row_id` (0, 1, 2, …):

- Opção rápida: abra o CSV no Sheets, **insira uma coluna A** e preencha `row_id` começando em `0`.
- Garanta a ordem das colunas: **A=row_id, B=persona, C=ataque, D=resposta**.
- Os `row_id` devem ser **contíguos** (0..N-1), na mesma ordem das linhas.

> 💡 O script calcula o total como `última_linha - 1`. Não deixe linhas vazias no meio.

### Aba `annotations`
Linha 1 (cabeçalho):

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| timestamp | session_id | name | row_id | h_evidencia | h_resistencia | batch_token |

### Aba `claims`
Linha 1 (cabeçalho):

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| session_id | row_ids | claimed_at | expires_at | batch_token | status |

---

## Passo 2 — Colar o código do Apps Script

1. Na planilha, vá em **Extensões → Apps Script**.
2. Apague o conteúdo padrão e **cole todo o conteúdo de `apps-script/Code.gs`**.
3. Salve (💾). Nomeie o projeto como `persona-annotation-api`.

---

## Passo 3 — Implantar como Web App

1. Clique em **Implantar → Nova implantação**.
2. Tipo: **Aplicativo da Web**.
3. Configure:
   - **Descrição**: `api`
   - **Executar como**: **Eu** (sua conta)
   - **Quem tem acesso**: **Qualquer pessoa** (necessário para o site chamar a API)
4. Clique em **Implantar** e **autorize** o acesso à planilha.
5. **Copie a URL do Web App** (termina em `/exec`).

---

## Passo 4 — Conectar o front-end

1. Abra `annotate/app.js`.
2. Substitua a linha:
   ```js
   const API_URL = "COLE_AQUI_SUA_URL_DO_APPS_SCRIPT";
   ```
   pela sua URL:
   ```js
   const API_URL = "https://script.google.com/macros/s/SEU_ID/exec";
   ```
3. Faça commit e push. O GitHub Pages publica automaticamente.

---

## Passo 5 — Testar (health check)

No navegador, abra a URL do Web App (GET). Você deve ver:

```json
{"ok":true,"service":"persona-annotation","time":"..."}
```

Se vir isso, a API está no ar. Agora abra a página de anotação e clique em **Carregar meu lote de 10**.

---

## Passo 6 — Concatenar as notas de volta no Drive

Quando quiser juntar as notas à base original, na aba `master` adicione (por exemplo) na coluna **E2**:

```
=ARRAYFORMULA(IF(A2:A="";"";IFERROR(VLOOKUP(A2:A;annotations!D:F;3;FALSE);"")))
```

- `annotations!D:F` → procura `row_id` (D) e retorna `h_evidencia` (F → 3ª coluna do intervalo).
- Para trazer também `h_resistencia`, use `VLOOKUP(...;annotations!D:G;4;FALSE)` na coluna F.

Isso cria colunas novas com as notas, **sem alterar** os dados originais.

> Se preferir no seu CSV local, exporte as abas e faça um `merge`/`join` por `row_id` (pandas: `master.merge(annotations, on='row_id', how='left')`).

---

## Segurança (o que já está embutido)

| Proteção | Como funciona |
|---|---|
| **Anti-sobrescrita** | `annotations` é append-only; `(session_id,row_id)` só grava na 1ª vez. |
| **Colisão entre anotadores** | Se outro já anotou o `row_id`, o servidor rejeita (não sobrescreve). |
| **N-10 / reserva** | Cada lote reserva 10 ids por 30 min na aba `claims`. |
| **Anti-sabotagem** | Nota fora de 1–5, payload > 2KB ou `row_id` fora do lote → rejeitado. |
| **Rate-limit** | 1 submit/segundo por sessão. |
| **Concorrência** | `LockService` serializa as escritas críticas. |

### Boas práticas extras (recomendado)
- **Proteja a aba `master`**: clique com o botão direito → *Proteger intervalo* → só você edita.
- **Não compartilhe o link de edição** da planilha com anotadores (eles nem precisam).
- Compartilhe apenas o **link do site** (GitHub Pages).

---

## Limites gratuitos (quota)
- Apps Script Web App: ~**30 execuções simultâneas**; tempo máx. 6 min/execução.
- Para 1–5 anotadores, está **muito folgado**.

---

## Solução de problemas

| Sintoma | Causa provável | Correção |
|---|---|---|
| `API_URL não configurada` | esqueceu o Passo 4 | edite `annotate/app.js` |
| `Aba nao encontrada: master` | nomes das abas diferentes | renomeie p/ `master/annotations/claims` |
| CORS / "failed to fetch" | implantação errada | reimplante como *Executar como: Eu* + *Qualquer pessoa* |
| `empty` ao carregar | master sem dados ou tudo anotado | confira aba `master` |
| Notas não aparecem | aba errada | confira cabeçalhos de `annotations` |
