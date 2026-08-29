# Painel administrativo — o que a API já dá e o que falta

Levantamento feito de fora, do lado de quem vai construir o painel
(2026-08-27). Serve para duas coisas: **não reconstruir o que já existe**, e
decidir o que sobe antes de alguém desenhar tela nenhuma.

A ordem importa. Uma tela desenhada antes das rotas existirem desenha
controles que a API não sabe responder, e aí é o desenho que passa a ditar o
contrato em vez do contrário.

Nada aqui é spec. Cada fatia que for aprovada vira uma spec em
[`specs/`](specs/) pelo caminho normal do repositório.

---

## As seis áreas de um painel, e onde cada uma está

| área | estado |
| --- | --- |
| Catálogo — produtos | **completo** |
| Catálogo — categorias | **completo** |
| Catálogo — variantes | **incompleto**: só criar e repor estoque |
| Pedidos | **completo** |
| Clientes | **não existe** — a permissão existe, a rota não |
| Relatórios | **completo** para as quatro perguntas que o painel fez |
| Acesso (promover usuário, conceder permissão) | **não existe** em rota; o schema já prevê |

## Já existe — não reconstrua

Levantado do documento OpenAPI publicado, que é o contrato real.

**Produtos.** `GET /products` já é consciente de privilégio: com um token que
carrega `products.read`, o filtro `status` (`DRAFT | ACTIVE | ARCHIVED | all`)
libera, e sem ele é `403` — não um filtro silenciosamente ignorado. Junto vêm
`page`, `perPage`, `category`, `search`, `sort` e faixa de preço. Um painel de
catálogo tem a listagem inteira de que precisa.

`POST /products` cria (nasce `DRAFT`, aceita `variants[]` em ordem),
`PATCH /products/{id}` edita tudo — inclusive `status`, que é como um produto
chega a `ACTIVE`; **não há rota de publicar separada** — e
`DELETE /products/{id}` arquiva em vez de apagar, devolvendo o produto
arquivado.

**Categorias.** `GET`, `POST`, `PATCH`, `DELETE` — CRUD completo. Gated em
`products.create`/`update`/`delete` de propósito: catálogo é uma capacidade
só.

**Pedidos.** `GET /orders` lista com `page`, `perPage`, `status` e `userId`
(este último exige `orders.read`; sem ele a listagem é sempre só do próprio
chamador). `GET /orders/{id}`, e as cinco transições de back-office:
`mark-paid`, `ship`, `deliver`, `cancel`, `refund`.

**O padrão de leitura privilegiada, que as rotas novas devem copiar.** Um
produto não-`ACTIVE` responde **404** a quem não tem `products.read` — não
403. Pedido de outro cliente, idem. Isso não é descuido de status code: um 403
confirmaria a quem está sondando que existe algo ali. Toda leitura nova de
back-office tem que responder 404 pela mesma razão.

**Onde o padrão não se aplica, e por quê** (aprendido em
[`specs/reports.md`](specs/reports.md), invariante 10): ele protege a
*existência de um recurso*, então vale para toda rota que recebe um **id**.
Uma rota que não recebe id nenhum não tem existência a vazar — as quatro de
relatório respondem **403**, como `POST /orders/{id}/refund` já respondia. O
que um 403 ali revela é que `/reports` existe, e o documento OpenAPI publicado
já diz isso.

---

## O que falta

### 1. Variantes: renomear, reordenar, remover — o bloqueador

Hoje existe `POST /products/{id}/variants` (adicionar) e
`PATCH /products/{id}/variants/{variantId}/stock` (estoque absoluto). Falta o
resto, e a falta é concreta: as doze peças da AVESSO carregam uma única
variante `Único` que a migration do #19 criou, e **sem remoção não há como
trocá-la por P/M/G/GG/XGG**. A loja vende roupa sem tamanho por causa disto.

`specs/product-variants.md` deixou as três de fora de propósito — "criar é
seguro; remover precisa de política pro que já foi vendido, e política é
decisão, não detalhe". A política agora precisa ser escrita. O schema já
responde a metade das perguntas:

- **Renomear é seguro por construção.** `OrderItem.variantLabel` é *snapshot*:
  o rótulo foi copiado na compra, e renomear a variante não reescreve pedido
  nenhum. O único cuidado é `@@unique([productId, label])` — renomear para um
  rótulo já usado no mesmo produto é `409`.
- **Reordenar é barato.** `position` não tem unicidade e o desempate é por
  `id`, então não existe dança de swap: é um update em lote das posições que
  vieram. O comentário do modelo diz exatamente isso.
- **Remover tem duas armadilhas, e uma delas não é óbvia.**

  A primeira já está protegida: `OrderItem.variant` é `onDelete: Restrict`, ou
  seja, **o banco já se recusa a apagar um tamanho que alguém comprou**. A
  rota não precisa inventar a regra — precisa transformar a violação de FK num
  `409` com mensagem de verdade, em vez de deixar vazar um 500.

  A segunda é a que morde. `CartItem.variant` é `onDelete: **Cascade**`, e o
  comentário do modelo diz por quê: *"o FK cascateia como higiene teórica; o
  catálogo nunca apaga produto de verdade, e a v1 não tem rota que remova
  variante"*. **Criar a rota torna esse cascade real.** Remover um tamanho
  passa a apagar, em silêncio, a linha correspondente do carrinho de qualquer
  pessoa que o tivesse — sem aviso, sem 409, sem nada em tela. A spec de
  remoção tem que decidir isto explicitamente, e há pelo menos três saídas:
  recusar remover enquanto houver carrinho apontando; deixar cascatear e
  aceitar que a sacola encolhe sem explicação; ou cascatear e marcar o
  carrinho de alguma forma que o storefront saiba dizer o que sumiu.

  E a terceira regra, que vem do próprio modelo: **todo produto tem ao menos
  uma variante, sempre**. Remover a última tem que ser recusado, ou o produto
  fica incomprável e nasce o "produto com variantes" versus "produto sem" que
  o modelo existe para evitar.

### 2. Clientes — a permissão existe, a rota não

`customers.read` está no catálogo de permissões e é concedida a `operator` e
`admin`. Nenhuma rota a exige, porque não há nenhuma rota de clientes.

**Cuidado de segurança, e não é teórico:** `User` carrega `passwordHash` e
`googleId`. Uma resposta montada por spread ou por `select *` vaza o hash da
senha de todo mundo numa listagem de back-office. O DTO de resposta tem que
ser escrito campo a campo, deliberadamente, como os outros deste repositório
já são.

### 3. Relatórios — ~~a permissão existe, a rota não~~ **feito**

Entregue em [`specs/reports.md`](specs/reports.md), fora da ordem sugerida no
fim deste documento: o painel da AVESSO já estava construído e fazia quatro
perguntas concretas, o que é gatilho suficiente. `GET /reports/product-sales`,
`/revenue`, `/carts` e `/unsold-products`, todas gated em `reports.read`.

O aviso que estava aqui — *"faturamento derivado é fácil de calcular errado"* —
virou metade daquela spec, e as três armadilhas que ele antecipava eram reais:
o que conta como venda (`CREATED` não é dinheiro; `CANCELLED` e `REFUNDED`
devolvem estoque), qual relógio usar (`paidAt`, nunca `createdAt`) e em que
fuso a semana é cortada (em UTC, todo domingo à noite de uma loja brasileira
cai na semana seguinte).

**As quatro perguntas e nada mais.** Ticket médio, conversão, reembolso por
período e quebra por tamanho ficaram de fora de propósito, registrados nas
decisões adiadas da spec.

### 4. Acesso: promover usuário e conceder permissão

Hoje promover alguém a `admin` é um `UPDATE` no banco, e o runbook de loja
nova documenta isso. O schema, porém, já previu a versão em rota:
`UserPermission` tem `grantedById` e `grantedAt` — **a proveniência de uma
concessão foi desenhada e nunca exposta**.

Esta é a rota mais perigosa do sistema inteiro e merece a spec mais cuidadosa.
Três regras que ela não pode não ter:

1. **Uma permissão própria para conceder permissão.** Hoje `admin` é
   literalmente "todas as permissões do catálogo", então não existe nada que
   `admin` tenha e `operator` não tenha *por natureza* — só pela lista. Uma
   rota de concessão precisa de algo como `users.grant`, que entra no catálogo
   e vai só para `admin`.
2. **Recusar conceder a si mesmo.** Sem isso, qualquer conta que alcance a
   rota se promove.
3. **Recusar conceder o que o chamador não tem.** Um `operator` comprometido
   não pode passar a distribuir `orders.refund` se ele próprio não o tem.

Sem as três, uma conta de operador comprometida vira administrador. Com elas,
o estrago para na permissão que o atacante já tinha.

### 5. Imagens de produto

`imageUrls` é uma lista de strings e não há upload — está registrado como fora
de escopo desde a v1. **A resposta segura continua sendo essa**: o painel cola
uma URL. Se um dia entrar upload de verdade, o caminho é URL assinada direto
para o storage, não um endpoint multipart que põe esta API no ramo de
manipular arquivo — tipo, tamanho, conteúdo e o que mais vier junto.

### 6. Trilha de auditoria — o que falta e ninguém pediu ainda

Hoje `ship`, `deliver`, `mark-paid`, `refund`, `cancel` e toda escrita de
catálogo não deixam registro de **quem** fez. `payment_events` guarda o que o
provedor disse, que é outra coisa.

Com um operador só, isso é aceitável. Com dois, é a primeira pergunta de
qualquer incidente — e `refund` mexe em dinheiro de verdade. A versão honesta
mais barata é uma tabela `admin_actions` (ator, ação, tipo e id do alvo,
snapshot do payload, timestamp), escrita na mesma transação da mudança para
não poder divergir dela.

Não é bloqueador do painel. É bloqueador de um painel com mais de uma pessoa.

---

## A fundação aguenta? Sim, com três ressalvas

A pergunta era se o commerce-core de hoje consegue receber essas rotas com
segurança. Consegue, e a base é melhor do que o normal:

- **Rota nova nasce privada.** O `JwtAuthGuard` é global e as rotas públicas
  optam por sair com `@Public`. Ninguém expõe um endpoint de back-office por
  esquecer um decorator — o esquecimento falha fechado.
- **Autorização é por permissão, nunca por role**, e as permissões são
  resolvidas do banco a cada requisição (o access token carrega só o `sub`).
  Permissão revogada é revogada agora, não em quinze minutos.
- **`@RequirePermissions` é AND**, e existe teste de regressão para a
  armadilha que já mordeu uma vez: o `Reflector` devolve `undefined` numa rota
  sem metadata, e um autofix de lint já removeu essa checagem e derrubou todas
  as rotas não anotadas.
- **404 em vez de 403 nas leituras privilegiadas** já é o padrão da casa.
- **Migration termina com RLS ligada e nenhuma policy**, por convenção do repo.

As ressalvas:

1. **Rate limiting é em memória, por instância.** Já está registrado no
   `status.md` como o item de operação mais importante. Duas consequências
   para o painel: vira ficção na segunda instância, e as rotas de escrita de
   back-office hoje não têm limite nenhum — um operador autenticado pode
   martelar `refund` à vontade. Risco baixo com uma pessoa de confiança, real
   quando a equipe cresce.
2. **Os limites são chaveados no IP do chamador**, lido de `cf-connecting-ip`.
   Um painel construído como BFF — que é como o storefront é — faz todo o
   tráfego sair de um IP só, então **todos os administradores dividem o mesmo
   balde de login**. Vale decidir antes de um bloqueio de tentativas começar a
   atingir a equipe inteira.
3. **Não há auditoria** (item 6 acima).

Nenhuma das três impede começar. As três merecem estar escritas antes de
alguém achar que estão resolvidas.

---

## Ordem sugerida

1. **Variantes: renomear, reordenar, remover.** É o único item que hoje
   bloqueia dado real — sem ele o catálogo publicado vende roupa sem tamanho.
   Uma spec, e a política de remoção é o coração dela.
2. **Clientes: listar e ver.** Pequena, e o cuidado inteiro está no DTO de
   resposta.
3. **Acesso: conceder e revogar permissão.** A spec mais cuidadosa das três.
   Depois das duas acima, porque o painel é útil sem ela e perigoso se feita
   com pressa.
4. **Auditoria**, quando existir a segunda pessoa com acesso.
5. ~~**Relatórios**, por último, ou nunca.~~ **Feito** — fora de ordem, porque
   o painel já existia e já perguntava. Ver o item 3.

## O que não fazer

- **Não desenhar a tela de produto antes do item 1.** Ela desenharia controles
  de tamanho que a API não sabe responder.
- **Não construir UI de cupom.** As permissões `coupons.*` existem no catálogo
  e não têm feature atrás — estão reservadas de propósito.
- **Não inventar uma rota de "publicar".** `PATCH /products/{id}` com
  `status: "ACTIVE"` é o caminho, e é deliberado.
- **Não abrir rota que devolva `User` inteiro.** Ver item 2.
