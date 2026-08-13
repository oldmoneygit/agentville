# Memória Persistente do Projeto — Instruções

> Carregado em toda sessão via `@` no CLAUDE.md raiz. **Fonte canônica deste projeto**: tem precedência sobre qualquer instrução de memória no CLAUDE.md global do desenvolvedor — incluindo a regra global de arquivar em `.claude/memory/archive/`. **Aqui a entrada que sai da memory migra para o vault Obsidian, não para um archive.**

## O que é

- `.claude/memory/` = memória de longo prazo do time, versionada no git.
- **1 arquivo = 1 fato.** `MEMORY.md` = índice (a única parte sempre em contexto). Entrada que sai da memory **migra para o vault Obsidian** (ver Sanitação) — nunca some sem destino, nunca vai para archive.
- Não confundir com o vault Obsidian (`vault-obsidian/`, contexto largo por trás dos fatos, acesso só via `mcp__obsidian__*` — rule `obsidian`), nem com `README`/`docs/` (documentação oficial), nem com `CLAUDE.md` (stack + convenções).

## Quando salvar — teste das 3 perguntas

Salve **somente se as 3 respostas forem SIM**. Qualquer NÃO → não salve.

1. **Custou caro?** Descoberto após falhas repetidas, correção do usuário, incidente, ou comportamento que nenhuma doc registra.
2. **Vai se repetir?** A situação volta em sessões futuras — não é evento único já encerrado.
3. **Fora do alcance?** Uma sessão futura NÃO derivaria isso lendo código, git history, CLAUDE.md ou rules.

Não espere ser pedido: fato que passa no teste → salvar é o passo final da tarefa.

### Exemplos calibrados

| Candidato                                                                                                                              | Veredicto          | Por quê                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| "Usuário trabalha direto na `main`; não force feature-branch sem pedir"                                                                | ✅ `feedback`      | preferência de workflow, corrige comportamento futuro    |
| "`lsof` não mantém o fd do transcript aberto entre appends — sessão ativa cai nas heurísticas de idle, não no `lsof`"                  | ✅ `architecture`  | descoberto por observação, invisível numa leitura rápida |
| "Extensão cobre 2 brands (Claude Code + Antigravity) com formatos de log divergentes; detecção nova cobre ou no-op explícito no outro" | ✅ `business-rule` | decisão de escopo que muda como o código é escrito       |
| "Logs vivem em `~/.claude/projects/**/*.jsonl` e `~/.gemini/antigravity-ide/brain/**/transcript.jsonl`"                                | ✅ `reference`     | onde vive info externa, não está no repo                 |
| "`npm run test` usa vitest"                                                                                                            | ❌                 | derivável do package.json                                |
| "Bug do parser corrigido no commit X"                                                                                                  | ❌                 | git history já registra                                  |
| "Publicar `.vsix` até sexta"                                                                                                           | ❌                 | temporário                                               |
| Resumo do que a sessão fez                                                                                                             | ❌                 | é log, não conhecimento                                  |

## Tipos (prefixo do nome do arquivo = tipo)

| Tipo            | Use para                                                                |
| --------------- | ----------------------------------------------------------------------- |
| `feedback`      | correção/orientação do usuário sobre COMO trabalhar (inclua o porquê)   |
| `architecture`  | padrão ou armadilha técnica descoberta após falhas                      |
| `business-rule` | regra que afeta o código e não é óbvia no repo                          |
| `project`       | fato durável do projeto não derivável do código (decisões, constraints) |
| `reference`     | onde vive informação externa (paths de log, APIs, dashboards, tickets)  |

## Como salvar — passos mecânicos, nesta ordem

1. **Dedup primeiro**: busque no `MEMORY.md` 2-3 palavras-chave do fato. Já existe entrada sobre o tema → **atualize o arquivo existente**, nunca crie duplicata. Entrada existente está errada → corrija-a ou migre-a para o vault (Sanitação).
2. **Gate de sanitação**: rode `wc -l -c .claude/memory/MEMORY.md`. Linhas ≥ 110 **ou** bytes ≥ 21000 → execute a Sanitação (seção abaixo) antes de continuar.
3. **Arquivo**: crie `.claude/memory/<tipo>-<slug-kebab>.md`:

```markdown
---
name: <tipo>-<slug-kebab>
description: resumo de 1 linha — usado para decidir relevância em sessões futuras
metadata:
  type: feedback | architecture | business-rule | project | reference
---

Fato ou regra em 1-3 frases. **Why:** por que importa / por que foi difícil de descobrir. **How to apply:** quando e onde aplicar.
```

Corpo: máximo ~15 linhas. Passou disso, corte — o excedente pertence a `docs/` ou ao vault.

1. **Índice**: adicione 1 linha ao `MEMORY.md`:
   `- [Título curto](arquivo.md) — hook de ≤ 140 caracteres`
   Escreva o hook com os termos que uma sessão futura buscaria: nome do módulo, mensagem de erro, comando.

## Sanitação (obrigatória ao atingir o gate) — migra para o vault, nunca archive

Para **cada** entrada do índice, migre para o vault Obsidian se **qualquer** critério valer:

- **(a) Resolvida** — descreve problema já corrigido/mergeado E não previne a reintrodução do erro.
- **(b) Duplicada** — o conteúdo já está em CLAUDE.md, rules ou docs.
- **(c) Pontual** — incidente único, sem recorrência, com mais de 60 dias.
- **(d) Órfã** — cita arquivo, flag, fluxo ou ferramenta que não existe mais no repo.

Procedimento por entrada reprovada, nesta ordem — o vault não tem limite de notas e o MCP `obsidian` precisa estar carregado (rule `obsidian`):

1. **Dedup**: `mcp__obsidian__search_notes_tool` com 1 termo específico do fato. Tema já existe → `mcp__obsidian__edit_note_section_tool` na nota existente; não crie duplicata.
2. **Contrato**: `mcp__obsidian__get_note_template_tool` no path da pasta-alvo → devolve headings/frontmatter obrigatórios e o skeleton. Siga exato: o servidor rejeita nota fora do contrato. Nunca preencha `name` (auto do filename). `## Related` (última heading do template) só com `[[wikilinks]]` de notas que existem — órfão vira `ToolError`.
3. **Criar**: `mcp__obsidian__create_note_tool`, filename kebab-case, pasta pelo tipo da memory:

   | Tipo da memory             | Pasta no vault  |
   | -------------------------- | --------------- |
   | `architecture`, `feedback` | `03-knowledge/` |
   | `business-rule`            | `03-knowledge/` |
   | `project`                  | `01-projects/`  |
   | `reference`                | `04-resources/` |

4. **Confirmar**: `mcp__obsidian__read_note_tool` no path criado. Sem leitura bem-sucedida, a migração NÃO aconteceu.
5. **Só então apagar**: `rm .claude/memory/<arquivo>.md` e remova a linha correspondente do `MEMORY.md`.
6. Reescreva o `MEMORY.md` apenas com os vivos, hooks ≤ 140 caracteres. Só então salve a nova entrada.

🔴 `rm` antes do passo 4 é proibido. Confirmação falhou — ex.: MCP `obsidian` não carregado (reinicie o Claude Code) → **mantenha** o arquivo na memory e reporte ao usuário. Subagente que cria a nota **não** executa o `rm`: quem apaga é quem confirmou a leitura.

Em dúvida se uma entrada está viva → **mantenha**. Migrar depois custa nada; conhecimento perdido custa caro.

## Como ler

- Início de qualquer tarefa não-trivial: escaneie o `MEMORY.md` (já em contexto) e **leia o arquivo** das entradas relevantes antes de agir — o hook é ponteiro, não o conteúdo.
- Memória não cobriu? Complemente no vault: `mcp__obsidian__search_notes_tool` (rule `obsidian`). Memória = fato curto; vault = o contexto largo por trás dele.
- Memória envelhece: se cita arquivo/flag/comando, confirme que ainda existe antes de aplicar.
- Conflito entre memória e código atual → **o código vence**; atualize ou migre a memória para o vault no fim da tarefa.


