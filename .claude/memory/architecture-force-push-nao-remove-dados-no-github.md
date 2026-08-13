---
name: architecture-force-push-nao-remove-dados-no-github
description: Force-push não apaga objetos no GitHub — commits órfãos seguem legíveis por SHA via API REST; sanitizar histórico antes de tornar um repo público exige repo novo ou GC do Support.
metadata:
  type: architecture
---

`git push --force` com histórico reescrito (squash/filter-repo) **não remove os objetos
antigos do GitHub**. Os commits ficam órfãos, mas continuam acessíveis por SHA
anonimamente via API REST — `/commits/<sha>`, `/git/trees/<sha>?recursive=1` e
`/git/blobs/<sha>` retornam 200 e servem o conteúdo integral. `git fetch <sha>` e
`raw.githubusercontent.com` retornam 404, o que dá a falsa impressão de que os dados
sumiram. O GitHub não roda GC automaticamente.

**Why:** verificado na prática ao tornar este repo público após sanitizar fixtures com
dados de terceiros — os blobs antigos seguiam legíveis sem autenticação. Nenhuma
verificação local (`git log -S` na branch nova) detecta isso, porque o problema é
server-side.

**How to apply:** ao sanitizar histórico antes de abrir um repositório, force-push é
insuficiente. Ou **delete e recrie o repositório** (efetivo e imediato; barato quando não
há stars/forks/issues), ou abra ticket no GitHub Support pedindo o GC dos objetos órfãos
— mantendo o repo privado até a confirmação. Sempre valide de fora, sem token:
`curl -s -o /dev/null -w "%{http_code}" https://api.github.com/repos/<owner>/<repo>/git/blobs/<sha>`
com cache-buster; a API do GitHub tem cache de CDN que devolve 200 por alguns segundos
após a mudança de visibilidade.
