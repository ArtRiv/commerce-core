# Spec: variant-management (renomear, reordenar e remover variante)

## Status

`implementado`

**492 testes unitários** (24 novos), `lint:check`, `typecheck`, `build`, o
`openapi.json` regenerado — **42 operações**, de 39 — e a suíte e2e inteira
verde: **206 testes em 9 arquivos**, 17 deles novos, sem nenhuma regressão nos
189 que já existiam. Entre os novos, os três critérios que só um banco de
verdade pode falsificar:

1. a recusa de um tamanho vendido, com o pedido intacto depois;
2. a linha de carrinho sumindo junto com a variante, e o `GET /cart` da vítima
   voltando com um item a menos e o subtotal refeito;
3. a recontagem abortando quando uma quarta sacola chega entre o aviso e a
   confirmação — encenada de verdade, inserindo a linha entre as duas
   chamadas.

**Onde o e2e rodou, e o que precisou ser construído para ele rodar.** Não
existe um terceiro projeto Supabase para gastar, e a suíte dá `TRUNCATE` no
banco para onde apontar. A saída foi um **schema dedicado dentro do banco de
desenvolvimento** (`e2e`), reconstruído por `pnpm e2e:setup` a partir das
migrations de verdade e do mesmo seed da produção. O procedimento e as duas
travas estão em [`../workflow.md`](../workflow.md).

Uma armadilha encontrada montando isso, e ela vale mais que o procedimento:
**`search_path` move o SQL cru e não move o Prisma.** Sem um schema
configurado no adaptador, o Prisma qualifica tudo com `public` — então a
primeira montagem "isolada" truncou o schema de teste vazio e semeou o banco
de desenvolvimento, com o script relatando sucesso. Um teste que rodasse
assim leria e escreveria dado real passando em tudo. O schema agora sai da URL
**uma vez só** (`src/prisma/connection-schema.ts`) e alimenta as duas
metades, que por construção não podem mais discordar.

## Objetivo

Fechar as três operações de variante que a v1 deixou de fora — renomear,
reordenar e remover — para que o back-office consiga **corrigir** um catálogo
já publicado, não só acrescentar a ele. Hoje as doze peças da AVESSO carregam
uma variante `Único` que a migration do #19 criou, e não existe caminho por
API para trocá-la por P/M/G/GG/XGG: a loja vende roupa sem tamanho.

Renomear e reordenar são mecânica. **A política de remoção é a spec** — o
resto é consequência dela.

## Escopo

### Entra

- `PATCH /products/{id}/variants/{variantId}` — renomeia um tamanho
- `PATCH /products/{id}/variants/order` — reordena a lista inteira de uma vez
- `DELETE /products/{id}/variants/{variantId}` — remove um tamanho, sob a
  política abaixo
- **A decisão explícita sobre o `onDelete: Cascade` de `cart_items`**, que
  hoje é hipótese e passa a ser comportamento real no minuto em que a rota de
  remoção existir — resolvida com uma confirmação de duas partes e a
  destruição feita pela aplicação, não pelo cascade
- Transformar a violação de FK de `order_items` (`onDelete: Restrict`) num
  `409` com mensagem, em vez de um `500` vazando do Prisma
- O conserto da `position` padrão de `POST /products/{id}/variants`, que a
  remoção torna fácil de encontrar (ver "Um conserto que vem junto")

### Não entra (fica pra depois)

- **Status de variante** (arquivar um tamanho em vez de apagá-lo). Ver
  "Alternativa considerada e recusada"
- **Aviso ao cliente** de que uma linha sumiu da sacola. Ver "Decisões
  adiadas" — é uma tabela e um ciclo de vida, não um campo
- **Auditoria de quem removeu.** É o item 6 de
  [`../admin-api.md`](../admin-api.md) e vale para toda escrita de
  back-office, não só para esta
- **Rate limit em escrita de back-office.** Ressalva 1 do mesmo documento
- Preço, peso ou estoque por esta rota — estoque já tem a sua
  (`PATCH …/variants/{variantId}/stock`), preço e peso continuam adiados por
  [`product-variants.md`](product-variants.md)
- **Mover uma variante entre produtos**, ou fundir duas numa

### Sobre quebrar o contrato

Não quebra nada. São três rotas novas e nenhuma mudança de resposta
existente: `ProductResponse` já traz `variants`, e é ela que as três
devolvem. Um consumidor que não regerar o cliente tipado continua correto —
só não enxerga as rotas novas.

## A política de remoção

Remover um tamanho esbarra em três paredes, e elas não são do mesmo tipo. A
ordem em que a rota as verifica é a ordem em que estão escritas aqui: as
inegociáveis primeiro, para que a mensagem devolvida seja a que o operador
não consegue contornar.

### Parede 1 — a última variante não sai. Nunca.

Todo produto tem ao menos uma variante, **sempre**. É a invariante que
[`product-variants.md`](product-variants.md) escolheu para não existirem dois
caminhos de código ("produto com variante" e "produto sem"), e a migration a
estabeleceu para o catálogo inteiro. Um produto sem variante é incomprável e
não tem representação correta na vitrine.

`409`, sem flag que contorne. Quem quer tirar o produto de venda tem a rota
que já existe: `DELETE /products/{id}`, que arquiva.

### Parede 2 — tamanho vendido não se apaga. Também nunca.

`OrderItem.variant` é `onDelete: Restrict`: **o banco já recusa**. A rota não
inventa a regra, ela dá voz à recusa — conta os `order_items` antes e devolve
`409` com uma frase de verdade, em vez de deixar o `P2003` virar `500`.

O pré-check é a **mensagem**; o FK continua sendo a **garantia**. Se um
checkout entrar entre a contagem e o `DELETE`, o banco recusa e o handler de
`P2003` devolve o mesmo `409`. As duas camadas existem porque respondem a
perguntas diferentes: uma é legibilidade, a outra é correção.

**E é aqui que renomear deixa de ser cosmético.** Quando a parede 2 fecha, a
variante `Único` fica presa para sempre — mas o destravamento da AVESSO não
depende de apagá-la: renomeia-se `Único` para `P`, corrige-se o estoque pela
rota que já existe, e acrescentam-se M, G, GG e XGG. Remover é a limpeza;
**renomear é o destravamento**, e funciona mesmo no pior caso.

### Parede 3 — carrinho: recusa por padrão, com um jeito explícito de passar

Esta é a que o schema não resolve sozinho, e a razão de a spec existir.

`CartItem.variant` é `onDelete: Cascade`. O comentário do modelo é honesto
sobre por quê: *"o FK cascateia como higiene teórica; o catálogo nunca apaga
produto de verdade, e a v1 não tem rota que remova variante"*. **Criar a rota
torna o cascade real.** Remover um tamanho passaria a apagar, em silêncio, a
linha de carrinho de qualquer pessoa que o tivesse.

As duas saídas óbvias são ruins pelo motivo oposto uma da outra:

- **Recusar enquanto houver carrinho apontando** dá a uma sacola abandonada
  poder de veto sobre o catálogo. O carrinho aqui **não reserva estoque, não
  congela preço e não expira** — não há TTL, não há limpeza, não há carrinho
  de convidado que evapore. Uma linha esquecida em janeiro travaria a
  correção do catálogo em agosto, e não existe operação no sistema que a
  desfaça. Uma linha de carrinho é um desejo anotado, não uma promessa: ela
  não pode segurar o back-office refém.
- **Deixar cascatear e pronto** é a sacola encolhendo sem explicação, com o
  subtotal mudando sozinho entre duas visitas. O cliente não fez nada e o
  total é outro.

A saída é não escolher entre elas: **recusar por padrão, dizer quantas
sacolas seriam atingidas, e exigir uma confirmação explícita — de duas
partes — para prosseguir.**

```
DELETE /products/{id}/variants/{variantId}
  → 409 { message: "This size is in 3 shopping carts", cartLineCount: 3 }

DELETE /products/{id}/variants/{variantId}
       ?discardCartLines=true&expectedCartLineCount=3
  → 200, o produto sem aquele tamanho, as 3 linhas apagadas junto
```

Os dois parâmetros dizem coisas diferentes, e é por isso que são dois:

- **`discardCartLines=true` é a autorização**: *"eu autorizo apagar linha de
  carrinho de outras pessoas"*. Ele nomeia a consequência em vez de se chamar
  `force`, porque não dá para marcá-lo sem ter lido o que faz.
- **`expectedCartLineCount=3` é a confirmação do impacto**: *"o estrago que
  eu revisei era de três sacolas"*. Autorizar a classe da ação não é a mesma
  coisa que aceitar qualquer tamanho dela.

**Se o número mudou, a autorização caducou.** A contagem é refeita dentro da
transação da remoção; divergiu, nada é apagado e a resposta é `409` com a
contagem **nova**, para o operador revisar o impacto de novo. Uma quarta
sacola que apareça entre o aviso e a confirmação não é apagada por carona.

Sem o `expectedCartLineCount`, `discardCartLines=true` seria uma autorização
em branco — assinada uma vez, válida para qualquer estrago futuro. Por isso
os dois viajam juntos: mandar a autorização sem a confirmação é `400`, e
mandar a confirmação sem a autorização também.

### Como a remoção acontece de fato

Quatro passos, todos dentro de **uma transação**:

1. **Trava a linha da variante** com `SELECT … FOR UPDATE`.
2. **Reconta** as linhas de carrinho. Divergiu do `expectedCartLineCount` →
   aborta com `409` e a contagem nova.
3. **Apaga as linhas de carrinho explicitamente** (`deleteMany`).
4. **Apaga a variante.**

O passo 1 é o que torna o passo 2 verdadeiro, e não é decoração. Inserir uma
linha de carrinho apontando para a variante faz o Postgres pegar `FOR KEY
SHARE` na linha da variante, e `FOR UPDATE` conflita com ela: enquanto a
transação de remoção estiver aberta, **nenhuma sacola nova consegue entrar
naquele tamanho**. Sem a trava, a recontagem responderia sobre um instante já
passado e uma linha inserida logo depois seria levada pelo `CASCADE` sem
nunca ter sido contada — que é exatamente o buraco que o
`expectedCartLineCount` existe para fechar. A garantia é do banco, como a de
estoque no checkout, não de uma janela de tempo curta o suficiente.

O passo 3 é explícito **de propósito**, embora o `onDelete: Cascade` fizesse
o mesmo sozinho. O cascade continua no schema como rede de segurança
referencial — nunca como a regra de negócio. Uma regra que mora só na
definição de uma FK é uma regra que ninguém lê antes de mudar o schema, não
aparece em nenhum teste de unidade, e apaga dado de cliente sem uma linha de
código que se possa apontar. Aqui a linha existe, e está ao lado da contagem
que a autorizou.

O que isso compra: a sacola nunca encolhe por acidente, o catálogo nunca fica
refém, o painel ganha um diálogo que só pode ser escrito com o número na mão
— *"3 sacolas contêm este tamanho. Remover mesmo assim?"* — e o número que
ele mostrou é o número que vale na hora de apagar.

O que isso **não** compra: o cliente continua sem aviso. A sacola dele
encolhe, só que agora porque uma pessoa decidiu isso vendo o número certo, e
não porque um FK disparou sem ninguém saber. Fechar esse último buraco é a
primeira das decisões adiadas, com o esboço lá.

### Alternativa considerada e recusada: status de variante

Dar à variante um status próprio (`ACTIVE`/`ARCHIVED`) resolveria as três
paredes de uma vez: nada é apagado, o carrinho sobrevive, o pedido sobrevive.

Foi recusada por três razões, na ordem em que pesam:

1. **Contradiz a modelagem.** Ciclo de vida é do **produto** — variante não
   tem status próprio na v1, e essa foi uma decisão explícita, não um
   esquecimento.
2. **O custo cai em todo lugar, não aqui.** Um status obrigaria toda leitura
   de catálogo, o carrinho, a vitrine e o decremento de checkout a filtrar
   por ele. É a superfície inteira do módulo pagando por uma operação de
   back-office.
3. **Não resolve nem o caso que bloqueia.** `@@unique([productId, label])` é
   sobre linhas, não sobre linhas vivas: uma `Único` arquivada continua
   ocupando o rótulo `Único`, e continuaria aparecendo em toda consulta que
   esquecesse o filtro novo.

Se um dia uma loja real precisar tirar um tamanho de linha **sem** perder o
histórico de estoque dele, isso volta como spec própria. Hoje seria
generalidade inventada antes da hora ([`../../claude/context.md`](../../claude/context.md)).

## Regras de negócio / invariantes

- **Todo produto tem ao menos uma variante, sempre.** Remover a última é
  `409` e não há flag que passe por cima.
- **Tamanho vendido não se apaga.** `order_items` faz `Restrict`; a rota
  devolve `409`, nunca `500`.
- **Linha de carrinho não veta a remoção, mas também não some por acidente.**
  `409` com a contagem por padrão; `discardCartLines=true` autoriza a
  destruição e `expectedCartLineCount` confirma o tamanho dela. Os dois, ou
  nenhum.
- **O impacto confirmado é o impacto aplicado.** A contagem é refeita sob
  trava de linha dentro da transação; se mudou, nada acontece e o operador
  revisa de novo.
- **A remoção da variante e a das linhas de carrinho são atômicas.** Uma
  transação, quatro passos, e o `CASCADE` do schema segue existindo como rede
  referencial — nunca como a regra.
- **`label` continua único por produto.** Renomear para o rótulo de uma irmã
  é `409`. Renomear para o próprio rótulo atual é **no-op `200`** — não um
  `409` contra si mesma.
- **Renomear não reescreve pedido nenhum.** `order_items.variant_label` é
  snapshot; é para isso que ele existe. O **carrinho**, que lê ao vivo, passa
  a mostrar o rótulo novo — e isso está certo: o carrinho nunca prometeu um
  rótulo, ele mostra o catálogo de agora.
- **Ordem é a lista inteira, densa, numa transação.** O corpo da reordenação
  é o conjunto exato das variantes do produto; as `position` viram `0..n-1`
  na ordem enviada. Sem unicidade em `position` não existe dança de swap
  ([`product-variants.md`](product-variants.md)).
- **Uma reordenação parcial não tem leitura correta**, então não é aceita:
  mandar metade da lista não diz o que fazer com a outra metade. Mesma
  filosofia do `categoryIds` de `PATCH /products/{id}`, que também substitui
  o conjunto inteiro em vez de mesclar.
- **A variante é endereçada sob o seu produto.** Um `variantId` de outro
  produto é `404` — o segmento do produto na URL não é decoração
  (`assertVariantBelongsTo`, que já existe).
- **Produto `DRAFT` ou `ARCHIVED` aceita as três operações.** Isto é
  catálogo, não venda: consertar o tamanho de um produto arquivado é
  legítimo, e a rota de estoque já se comporta assim.

## Um conserto que vem junto: a `position` padrão de `addVariant`

Achado ao ler o código para escrever esta spec, e é anterior a ela.

`POST /products/{id}/variants` documenta que a nova variante vai **para o
fim** da lista, e implementa isso como `position ?? product.variants.length`
— o **número** de variantes, não a maior posição. As duas coisas só coincidem
enquanto as posições forem densas a partir de zero.

Elas já podem não ser: `CreateVariantDto.position` é do chamador, então um
`POST /products` com variantes em 0, 5 e 10 faz a próxima nascer em 3 — no
meio, não no fim. E **remover passa a produzir o mesmo estado por um caminho
muito mais comum**: tirar a variante do meio de 0, 1, 2 deixa 0 e 2, e a
próxima adição nasce em 2, empatada com a que já está lá. Empate não é erro
(o desempate por `id` resolve, e `product-variants.md` diz isso), mas a ordem
passa a depender de um UUID — que é precisamente a coisa que a coluna
`position` existe para não deixar acontecer.

O conserto é trocar o padrão para `max(position) + 1`, que é o que a frase
"vai para o fim" sempre quis dizer. Uma linha, sem mudança de contrato, e
mantém verde o teste que já existe.

**A alternativa que não foi escolhida** era a remoção renumerar as
sobreviventes para `0..n-1`. Faria as posições serem sempre densas, mas
reescreveria a `position` de variantes que ninguém pediu para mexer, e
espalharia a correção por um caminho de escrita a mais. A reordenação
continua sendo a única operação que densifica, e é a única que precisa
disso.

## Superfície da API

| Método | Rota | Descrição | Auth |
| ------ | ---- | --------- | ---- |
| PATCH | `/products/{id}/variants/order` | **nova** — reordena a lista inteira | `products.update` |
| PATCH | `/products/{id}/variants/{variantId}` | **nova** — renomeia | `products.update` |
| DELETE | `/products/{id}/variants/{variantId}` | **nova** — remove, sob a política | `products.delete` |

O `DELETE` aceita `?discardCartLines=true&expectedCartLineCount=N`, que só
significam alguma coisa juntos.

Rotas: 39 → **42**.

As três devolvem **o produto inteiro**, com as variantes em ordem de exibição
— igual a `POST /products/{id}/variants` e a `PATCH …/stock`. O painel
re-renderiza a partir de uma resposta só, sem precisar de um `GET` depois.

### Por que `DELETE` pede `products.delete` e as outras `products.update`

`products.update` é "editar o catálogo": rótulo, ordem, estoque — tudo
reversível. `products.delete` é a permissão que já governa as únicas
destruições reais do catálogo (arquivar produto, apagar categoria), e
remover uma variante é destruição real: leva o estoque daquele tamanho e
pode levar linha de carrinho junto.

Hoje isso não muda quem pode fazer o quê — `operator` tem só
`products.read`, então as duas são de `admin`. Muda no dia em que alguém der
`products.update` a um estagiário para arrumar rótulo e estoque: essa pessoa
não passa a poder descartar tamanho e sacola dos outros junto.

### DTOs (esboço)

```ts
export class RenameVariantDto {
  /** Obrigatório: a rota faz exatamente uma coisa. 1..20, como no create. */
  label: string;
}

export class ReorderVariantsDto {
  /**
   * O CONJUNTO EXATO das variantes do produto, na ordem desejada. Nem uma a
   * menos (não daria pra saber onde vai o resto), nem uma repetida, nem uma
   * de outro produto. `position` vira o índice aqui dentro.
   */
  variantIds: string[];
}

/**
 * Query de DELETE. Ausentes = recusar se houver qualquer carrinho.
 *
 * Os dois andam juntos: autorização sem confirmação de impacto é uma
 * autorização em branco, e confirmação sem autorização não pede nada.
 */
export class RemoveVariantQueryDto {
  /** "Autorizo apagar linha de carrinho de outras pessoas." */
  discardCartLines?: boolean;
  /** "O estrago que revisei era este." Obrigatório com o de cima. */
  expectedCartLineCount?: number;
}
```

`discardCartLines` é o **primeiro parâmetro booleano de query do repositório**,
e o caminho óbvio está errado: `@Type(() => Boolean)` passa por
`Boolean('false')`, que é `true` — o valor que desliga a proteção seria o
valor que a liga. Vai com um `@Transform` estrito que aceita `'true'` e
`'false'` e recusa o resto no `400`, em vez de chutar.

Os `409` com corpo, na forma que o `409` de checkout já estabeleceu (mensagem
mais o dado que o cliente precisa para montar a tela):

```ts
// carrinho apontando, sem os dois parâmetros
{ message: 'This size is in 3 shopping carts', cartLineCount: 3 }

// expectedCartLineCount não bate com a contagem de agora
{ message: 'Cart line count changed from 3 to 4; review and confirm again',
  cartLineCount: 4 }

// última variante
{ message: 'A product must keep at least one variant' }

// já vendido
{ message: 'This size has been sold and cannot be removed' }
```

O `409` de "já vendido" **não** carrega a contagem de pedidos de propósito:
seria dado de pedido alcançável por uma permissão de catálogo, e
`products.delete` não implica `orders.read`.

Os dois `409` que carregam `cartLineCount` ganham uma classe de resposta
própria no documento (`VariantInCartsResponse`), em vez do `ErrorResponse`
genérico. O `409` de checkout hoje é documentado como `ErrorResponse` e
devolve `unavailableItems` — um campo que o cliente gerado não conhece. É um
buraco pequeno e conhecido; não vale reabrir a spec de pedidos aqui, mas
também não vale copiá-lo numa rota nova cujo único consumidor é um painel que
**precisa** do número para desenhar o diálogo.

### Uma armadilha de roteamento, e o precedente que ela segue

`PATCH /products/:id/variants/order` e `PATCH /products/:id/variants/:variantId`
têm o mesmo formato. Declarada na ordem errada, a segunda captura `order`
como um `variantId` e a reordenação vira um `404` inexplicável.

A rota literal é declarada **antes** da paramétrica no controller. Não é
truque novo: `products.controller.ts` já depende disso para
`PATCH :id/variants/:variantId/stock` vir antes de `PATCH :id`. Tem teste de
regressão próprio, porque é o tipo de coisa que um reordenamento inocente de
métodos quebra em silêncio.

## Critérios de aceitação

### Renomear

- [ ] Dado um produto com `M`, quando `PATCH …/variants/{id}` com
      `label: "Médio"`, então a variante passa a `Médio` e a resposta é o
      produto com a lista em ordem de `position`
- [ ] Dado um produto com `P` e `M`, quando renomeio `M` para `P`, então
      `409` e nenhuma das duas muda
- [ ] Dado `M`, quando renomeio `M` para `M`, então `200` e nada muda — não
      é `409` contra si mesma
- [ ] Dado um pedido que comprou `M`, quando renomeio `M` para `Médio`, então
      o pedido continua dizendo `M` (`variantLabel` é snapshot) e o carrinho
      de quem tem a linha passa a dizer `Médio`
- [ ] Dado um `variantId` que pertence a outro produto, então `404`
- [ ] Dado `label` vazio ou com mais de 20 caracteres, então `400`

`label` **só de espaços** ficou de fora deste critério de propósito.
`CreateVariantDto` não apara nem recusa `'   '` hoje, e fazer o rename mais
rígido que o create deixaria as duas rotas discordando sobre o que é um
rótulo válido. É um buraco pequeno e real — `'M'` e `' M'` passam as duas
pelo `@@unique` e desenham igual na vitrine, que é a ambiguidade que a
unicidade existe para impedir. O conserto é um `@Transform` de `trim` nas
duas rotas, e pertence a quem mexer no create.

### Reordenar

- [ ] Dados `P`, `M`, `G` em `position` 0, 1, 2, quando envio `[G, P, M]`,
      então as `position` viram 0, 1, 2 nessa ordem e a leitura devolve
      `G, P, M`
- [ ] Dado um `variantIds` sem uma das variantes do produto, então `400` e a
      ordem anterior intacta
- [ ] Dado um `variantIds` com um id repetido, então `400`
- [ ] Dado um `variantIds` contendo variante de outro produto, então `400` —
      pela mesma regra: não é o conjunto deste produto
- [ ] Dado um produto de uma variante só, quando envio `[ela]`, então `200` e
      nada muda
- [ ] As `position` são escritas numa transação só, então uma falha no meio
      não deixa a lista meio reordenada (unitário)

### Remover

- [ ] Dado um produto com `P` e `M`, quando removo `M`, então o produto fica
      só com `P` e a resposta já vem sem ele
- [ ] Dado um produto com **uma** variante, quando removo, então `409` e ela
      continua lá
- [ ] Dado um tamanho que aparece num `order_item`, quando removo, então
      `409` com mensagem — **não** `500` — e o pedido continua íntegro
- [ ] Dado um tamanho no carrinho de alguém, quando removo **sem** os
      parâmetros de confirmação, então `409` com `cartLineCount` e nada é
      apagado
- [ ] Dado o mesmo caso com `discardCartLines=true&expectedCartLineCount=3`
      batendo com a realidade, então a variante some, as 3 linhas de carrinho
      somem junto, e o `GET /cart` daquela pessoa volta com um item a menos e
      o `itemsSubtotalCents` recalculado
- [ ] Dado `expectedCartLineCount=3` quando a contagem virou 4, então `409`
      com `cartLineCount: 4`, a variante continua lá e **nenhuma** das 4
      linhas é apagada
- [ ] Dado `discardCartLines=true` sem `expectedCartLineCount`, então `400`
- [ ] Dado `expectedCartLineCount` sem `discardCartLines=true`, então `400`
- [ ] Dado `discardCartLines=x` (nem `true` nem `false`), então `400` — e
      `discardCartLines=false` significa `false`, não `true`
- [ ] Dado `discardCartLines=true&expectedCartLineCount=0` num tamanho que
      não está em carrinho nenhum, então remove normalmente — a autorização é
      permissão, não exigência
- [ ] As linhas de carrinho são apagadas pela aplicação, na mesma transação
      da variante — não pelo `CASCADE` (unitário: o `deleteMany` é chamado, e
      é chamado no `tx`)
- [ ] Dado um `variantId` de outro produto, então `404`

### Autorização e documento

- [ ] Dado um token de `customer`, então `403` nas três rotas; sem token,
      `401`
- [ ] Dado um token com `products.update` mas sem `products.delete`, então as
      duas de `PATCH` passam e o `DELETE` é `403`
- [ ] `PATCH /products/{id}/variants/order` não é capturada pela rota de
      renomear — `order` nunca é lido como um `variantId`
- [ ] O documento OpenAPI regenerado descreve as três rotas,
      `RenameVariantDto`, `ReorderVariantsDto` e o parâmetro
      `discardCartLines`

## Edge cases conhecidos

- **Uma quarta sacola entre o aviso e a confirmação** faz a recontagem
  divergir, e a remoção inteira é abortada com `409` e a contagem nova. É o
  comportamento desejado, e o custo dele é real: num tamanho muito disputado
  o operador pode ter que revisar duas vezes seguidas. Aceito — a alternativa
  é apagar sacola que ninguém viu, e a trava de linha faz a segunda tentativa
  ser decidida, não uma aposta.
- **`expectedCartLineCount` maior que a realidade** (as 3 sacolas viraram 1
  porque alguém finalizou a compra) também é `409`, apesar de o estrago ser
  *menor* do que o autorizado. A regra é "o impacto confirmado é o impacto
  aplicado", em ambas as direções: um número que não corresponde à realidade
  não foi revisado, foi adivinhado. A recuperação é barata — o `409` já traz
  a contagem certa, e no caso extremo de ela ser `0` o `DELETE` simples passa
  sozinho.
- **Uma adição ao carrinho concorrente com a remoção forçada** fica bloqueada
  pela trava de linha até a transação terminar, e então falha na FK — que o
  `POST /cart/items` hoje não traduz, porque ele lê a variante antes e faz
  `upsert` depois. O cliente veria `500` numa janela de milissegundos em vez
  do `404` que a mesma tentativa daria um instante depois. Fica registrado
  como buraco conhecido em vez de resolvido aqui: consertar direito é dar ao
  `upsert` do carrinho um handler de `P2003`, o que é mexer na spec de
  pedidos.
- **Corrida entre o pré-check "foi vendido?" e o `DELETE`.** Um checkout
  entra no meio, o `Restrict` recusa, e o `P2003` é traduzido para o mesmo
  `409`. É por isso que o pré-check não é a garantia.
- **Remover uma variante com estoque > 0** faz aquelas unidades sumirem da
  soma do produto. Não é erro: tirar um tamanho de linha é uma decisão de
  quem opera a loja, e o número que ela representa era estoque daquele
  tamanho, de mais nada.
- **Renomear para um rótulo que já existiu e foi removido** é livre: a
  unicidade é sobre as linhas que existem, não sobre as que já existiram.
- **Reordenar não mexe em pedido nem em carrinho.** `position` só existe para
  exibição; o carrinho carrega a `position` da variante na resposta e ela
  simplesmente passa a ser a nova.
- **Remover a penúltima variante** deixa o produto vendável em um tamanho só.
  Correto, e é exatamente o estado em que a migration do #19 deixou o
  catálogo inteiro.

## Estratégia de teste

Unitário onde a regra mora — as três operações em `ProductsService`, com o
Prisma mockado: as paredes na ordem certa, o no-op do rename contra si mesmo,
a validação de conjunto da reordenação, a tradução de `P2003`, a recontagem
que aborta, e o `deleteMany` das linhas de carrinho acontecendo **no `tx`**,
que é o que separa "apagamos" de "o banco apagou por nós".

e2e por cima, para as três afirmações que **só um banco de verdade pode
falsificar**:

1. o `Restrict` de `order_items` recusando a remoção de um tamanho vendido —
   um mock aqui provaria só que o mock foi programado para recusar;
2. a linha de carrinho sumindo junto com a variante numa transação só, e o
   `GET /cart` da vítima voltando com um item a menos e o subtotal refeito;
3. a recontagem abortando quando a realidade mudou entre o aviso e a
   confirmação — encenada inserindo a quarta linha entre as duas chamadas.

O e2e do rename cobre o critério que dá sentido ao snapshot: pedido criado,
variante renomeada, pedido relido ainda dizendo o rótulo antigo.

**O e2e roda contra banco descartável, nunca contra o publicado.** A suíte dá
`TRUNCATE` no banco para onde `DATABASE_URL` apontar, e o projeto Supabase
chamado `commerce-core-dev` é o que serve a loja publicada, apesar do nome
([`../admin-api.md`](../admin-api.md)).

## Decisões adiadas

- **Avisar o cliente do que sumiu da sacola.** É o buraco que a parede 3
  deixa aberto de propósito. O esboço honesto: uma tabela de avisos por
  usuário (usuário, o que sumiu, quando), escrita **na mesma transação** da
  remoção para não poder divergir dela, drenada na próxima leitura do
  carrinho. O que a torna uma spec e não um campo é o ciclo de vida: uma
  leitura que escreve, e a pergunta de quando o aviso morre se ninguém
  voltar.
- **Status de variante / arquivar um tamanho.** Ver "Alternativa considerada
  e recusada". Volta se uma loja real precisar tirar de linha sem perder o
  histórico.
- **Auditoria de quem renomeou, reordenou ou removeu.** Item 6 de
  [`../admin-api.md`](../admin-api.md): vale para toda escrita de
  back-office, e entra quando existir a segunda pessoa com acesso.
- **Rate limit nas escritas de back-office.** Ressalva 1 do mesmo documento.
  Nenhuma destas três tem limite, como nenhuma outra escrita de back-office
  tem hoje.
- **Mover uma variante de um produto para outro**, e **fundir duas variantes
  numa** (o que fazer com os dois estoques, e com duas linhas de carrinho da
  mesma pessoa que virariam uma). Nenhuma loja real pediu.
- **Remoção em lote.** Trocar `Único` por P/M/G/GG/XGG são cinco `POST` e um
  `DELETE`; um endpoint que substitui o conjunto inteiro de variantes de uma
  vez teria que decidir todas as três paredes por linha, e devolver um
  resultado parcial que o painel saberia exibir. Se a operação virar rotina,
  aí é uma spec.
