# Spec: product-variants (variantes de produto)

## Status

`implementado`

Entregue de uma vez: a migration (tabela, backfill, `CHECK`s e RLS), o
schema, `StockService` inteiro reapontado pra variante, o contrato do
catálogo (`findSellableByVariantIds`), carrinho e checkout endereçando
variante, as respostas, as duas rotas de back-office, unitários em cada
unidade e e2e por cima.

Três coisas mudaram em relação ao desenho original, e as três vieram de
escrever o código:

1. **A coluna `products.stock_quantity` foi removida**, não mantida como
   soma desnormalizada. O desenho dizia "mantenha `stockQuantity` no
   produto como soma das variantes"; manter a **coluna** faria isso ser uma
   segunda fonte da verdade, que é como se vende o que não se tem. O
   **campo da resposta** ficou, calculado na leitura — que é o que a grade
   precisava.
2. **`CartProductResponse` perdeu `stockQuantity`.** Numa linha de carrinho
   o único número que significa algo é o estoque daquele tamanho.
3. **Os dois `409` de estoque trocaram `productIds: string[]` por
   `unavailableItems`** com produto e rótulo. "Camiseta Preta esgotada" é
   mentira quando só o M acabou.

E uma coisa que o e2e encontrou e **não** foi consertada aqui: a ordem das
linhas do carrinho vem de `cart_items.id`, um UUID — estável, mas sem
significado. Virou entrada em [`../known-issues.md`](../known-issues.md)
com o esboço de conserto; o teste compara as linhas como conjunto e diz
por quê.

Verificado: 468 testes unitários verdes, `lint:check`, `typecheck` e
`build`. A suíte e2e inteira rodou contra o Supabase de **desenvolvimento**
(`commerce-core-dev`) — 189 testes em 8 arquivos, 188 verdes na primeira
passada; a única falha foi a ordem de linha acima, e depois de corrigir a
asserção `test/orders.e2e-spec.ts` passou inteiro sozinho.

A migration foi conferida contra dados de verdade: 3 produtos somando 42
unidades antes, 3 variantes somando 42 depois, todas `Único`, nenhum
produto sem variante, a linha de carrinho e o item de pedido remapeados.

**Ressalva de como ela foi aplicada:** `prisma migrate deploy` não roda
desta máquina — o *schema engine* morre contra o pooler de transação da
Supabase com `Error: Schema engine error:` e mensagem vazia. A migration
foi aplicada pelo mesmo driver `pg` que o app usa, numa transação, com a
linha correspondente escrita em `_prisma_migrations` com o checksum
SHA-256 correto do arquivo — o mesmo que `prisma migrate resolve --applied`
faria. Em produção nada disso se aplica: o `docker/entrypoint.sh` roda
`migrate deploy` normalmente e a migration nunca foi aplicada lá.

## Objetivo

Dar ao produto a unidade vendável que ele nunca teve: tamanho. Uma
camiseta não é um item com um estoque — são cinco (P, M, G, GG, XGG),
cada um com o seu, e a vitrine precisa poder dizer "este tamanho existe e
acabou", que é diferente de "este tamanho não existe". Estoque desce do
produto pra variante, e carrinho e pedido passam a endereçar variante.

## Escopo

### Entra

- Tabela `product_variants`: rótulo, ordenação explícita e estoque
- **Estoque só na variante.** A coluna `products.stock_quantity` deixa de
  existir; a migration transforma cada produto de hoje em exatamente uma
  variante `Único` carregando o estoque que ele tinha
- `variants` em `ProductResponse`, ordenadas por `position`
- `stockQuantity` em `ProductResponse` continua existindo, agora como
  **soma das variantes** — a grade do catálogo continua dizendo
  "Esgotado" a partir de um número só
- `POST /cart/items` passa a receber `{ variantId, quantity }`; as rotas
  de linha do carrinho passam a endereçar `variantId`
- `order_items` ganham `variant_id` e o **snapshot** `variant_label`
- Checkout decrementa o estoque **da variante**, atomicamente, e o `409`
  nomeia a peça (produto + tamanho) que faltou
- `POST /products` cria as variantes junto; `POST /products/{id}/variants`
  acrescenta um tamanho depois
- `PATCH /products/{id}/variants/{variantId}/stock` substitui
  `PATCH /products/{id}/stock`

### Não entra (fica pra depois)

- **Preço por variante.** O desenho tem um preço por produto,
  independente do tamanho; ver "Decisões adiadas"
- **Cor, e variantes de dois eixos** (tamanho × cor). Isso é matriz de
  opções e SKU composto, e nenhuma loja real pediu ainda
- **Renomear, reordenar ou remover variante.** Criar é seguro; remover
  precisa de política pro que já foi vendido (`order_items` faz
  `RESTRICT`), e política é decisão, não detalhe
- **Peso por variante.** GG pesa mais que P, e ainda assim a diferença
  não muda faixa de frete em nenhuma tabela realista
- **Caminho de compatibilidade** que aceite `productId` no carrinho. Ver
  "Sobre quebrar o contrato"
- Reserva de estoque no carrinho — continua fora, pelos mesmos motivos de
  [`catalog.md`](catalog.md)

## Sobre quebrar o contrato

Isto **quebra** `POST /cart/items`, as respostas do carrinho e as do
pedido. É deliberado, e não há caminho de compatibilidade.

Existe exatamente um consumidor — a loja AVESSO — ele está sendo escrito
agora, e regenera o cliente tipado a partir do `openapi.json` deste repo.
Um `productId` aceito "por enquanto" precisaria escolher uma variante
sozinho, e a única escolha possível seria "a primeira" — que é errada em
toda camiseta com mais de um tamanho. Um contrato que aceita uma pergunta
ambígua e responde com um chute é pior que um que recusa.

Este é o momento mais barato que esta mudança vai ter. Depois de a loja ir
ao ar, o mesmo PR custa uma migração coordenada de duas bases de código em
produção.

A quebra é **barulhenta**, e isso sai de graça: o `ValidationPipe` global
roda com `forbidNonWhitelisted`, então `POST /cart/items` com `productId` e
`POST /products` com `stockQuantity` respondem `400` nomeando a propriedade
que não existe — não `200` com o campo silenciosamente ignorado.

## Regras de negócio / invariantes

- **Todo produto tem pelo menos uma variante, sempre.** Não existe
  "produto sem variante": a migration dá `Único` a todos os que existem, e
  `POST /products` sem `variants` cria `Único` sozinho. Essa é a regra que
  impede o garfo — o dia em que existirem dois caminhos de código, "produto
  com variante" e "produto sem", este módulo vira impossível de manter.
- **Estoque mora na variante.** Não há segunda fonte da verdade: a coluna
  do produto foi **removida**, não deixada pra trás. Manter uma soma
  desnormalizada no produto seria um número que pode divergir do que a
  venda decrementa, e o dia em que divergir a loja vende o que não tem.
  `ProductResponse.stockQuantity` é calculado na leitura.
- **Preço mora no produto.** Uma camiseta custa o mesmo em P e em XGG.
  Isso é decisão, não esquecimento: generalidade não se inventa antes da
  hora ([`claude/context.md`](../../claude/context.md)), e preço por
  variante é uma coluna a mais em `product_variants` no dia em que uma
  loja real precisar — não hoje.
- **Ordem é `position`, nunca o rótulo.** P, M, G, GG, XGG em ordem
  alfabética é G, GG, M, P, XGG, que não é ordem de tamanho em idioma
  nenhum. `position` é inteiro explícito, e toda leitura ordena por
  `position asc, id asc` — o desempate por `id` pelo mesmo motivo da
  ordenação do catálogo ([`catalog-query.md`](catalog-query.md)): sem ele
  duas variantes de mesma posição podem trocar de lugar entre duas
  consultas.
- **Variante sem estoque aparece.** A resposta lista todas as variantes,
  com `stockQuantity: 0` quando é o caso. A vitrine risca o tamanho, não o
  esconde — esconder faz o cliente achar que a loja não fabrica aquele
  tamanho, e é a diferença entre "acabou, volta" e "não existe".
- **`label` é único por produto.** Duas variantes `M` na mesma camiseta são
  ambiguidade sem leitura correta possível.
- **O pedido congela o rótulo.** `order_items.variant_label` é snapshot, do
  mesmo jeito que `product_name` e `unit_price_cents` já são. Um tamanho
  renomeado depois não pode reescrever o que alguém comprou — um pedido é
  registro financeiro, e registro financeiro não muda de texto sozinho.
- **O decremento continua sendo um `UPDATE` condicional.** Só muda o
  alvo: `WHERE id = variantId AND stock_quantity >= n` mais o status
  `ACTIVE` do produto dono. Dois checkouts pela última unidade continuam
  sendo resolvidos pelo Postgres, não pela aplicação.
- **Produto arquivado continua recusando venda**, por todas as suas
  variantes. O filtro de status vive no produto porque o ciclo de vida é
  do produto — variante não tem status próprio na v1.
- **Toda tabela nova nasce com RLS deny-all na própria migration.** Regra
  do projeto, `product_variants` inclusive.

## Modelo de dados (esboço Prisma)

```prisma
model ProductVariant {
  id String @id @default(uuid())

  productId String  @map("product_id")
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  /// 'P' | 'M' | 'G' | 'GG' | 'XGG' | 'Único' — texto livre de propósito:
  /// numeração de calçado e tamanho de anel são a mesma coisa com outro
  /// alfabeto, e um enum obrigaria uma migration por loja nova.
  label String

  /// Ordem de exibição. Explícita porque alfabética está errada.
  position Int

  stockQuantity Int @default(0) @map("stock_quantity")

  cartItems  CartItem[]
  orderItems OrderItem[]

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@unique([productId, label])
  @@index([productId, position])
  @@map("product_variants")
}
```

`Product` perde `stockQuantity` e ganha `variants ProductVariant[]`.

`CartItem` troca `productId` por `variantId` (o produto vem pela
variante; guardar os dois é desnormalização que pode divergir) e a
unicidade vira `[cartId, variantId]`.

`OrderItem` **mantém** `productId` — é a rastreabilidade que já existia,
com `RESTRICT` — e ganha `variantId` (também `RESTRICT`) mais
`variantLabel`. A unicidade vira `[orderId, variantId]`: duas linhas do
mesmo produto em tamanhos diferentes são duas linhas legítimas.

## Superfície da API

| Método | Rota | Descrição | Auth |
| ------ | ---- | --------- | ---- |
| GET | `/products` | cada item ganha `variants`; `stockQuantity` vira a soma | pública |
| GET | `/products/{idOrSlug}` | idem | pública |
| POST | `/products` | body ganha `variants[]`, perde `stockQuantity` | `products.create` |
| POST | `/products/{id}/variants` | **nova** — acrescenta um tamanho | `products.update` |
| PATCH | `/products/{id}/variants/{variantId}/stock` | **substitui** `PATCH /products/{id}/stock` | `products.update` |
| PATCH | `/products/{id}` | perde `stockQuantity` do body | `products.update` |
| GET | `/cart` | linhas passam a trazer `variantId` e `variant` | autenticada |
| POST | `/cart/items` | body vira `{ variantId, quantity }` | autenticada |
| PATCH | `/cart/items/{variantId}` | endereça variante | autenticada |
| DELETE | `/cart/items/{variantId}` | endereça variante | autenticada |
| GET/POST | `/orders*` | itens ganham `variantId` e `variantLabel` | autenticada |

Rotas: 38 → 39 (uma nova, uma substituída).

### DTOs (esboço)

```ts
export class ProductVariantResponse {
  id: string;
  label: string;      // 'P' … 'XGG' | 'Único'
  position: number;   // 0-based; a ordem de exibição
  stockQuantity: number; // 0 é exibido, não escondido
}

export class ProductResponse {
  // ... inalterado
  /** SOMA das variantes. A grade diz "Esgotado" a partir daqui. */
  stockQuantity: number;
  /** Sempre ao menos uma. Ordenadas por position. */
  variants: ProductVariantResponse[];
}

export class CreateVariantDto {
  label: string;        // 1..20, não vazio
  position?: number;    // ausente = índice no array
  stockQuantity?: number; // ausente = 0
}

export class CreateProductDto {
  // ... sem stockQuantity
  /** Ausente = uma variante `Único` com estoque 0. */
  variants?: CreateVariantDto[];
}

export class AddCartItemDto {
  variantId: string; // uuid
  quantity: number;  // 1..999
}

export class CartItemResponse {
  variantId: string;
  quantity: number;
  product: CartProductResponse;  // sem stockQuantity — ver abaixo
  variant: CartVariantResponse;  // { id, label, position, stockQuantity }
}

export class OrderItemResponse {
  productId: string;
  productName: string;   // snapshot
  variantId: string;
  variantLabel: string;  // snapshot
  unitPriceCents: number;
  quantity: number;
}
```

`CartProductResponse` **perde** `stockQuantity` de propósito. Numa linha
de carrinho o único número que significa alguma coisa é o estoque
**daquele tamanho**; devolver a soma do produto convidaria exatamente o
bug de exibir "10 disponíveis" numa linha de M que acabou.

### O 409 do checkout

Os dois `409` de checkout que hoje devolvem `productIds: string[]` passam
a devolver a peça inteira, porque "Camiseta Preta" sem o tamanho não dá
pra exibir:

```ts
{
  message: 'Insufficient stock or product no longer for sale',
  unavailableItems: [
    { variantId, productId, productName, variantLabel }
  ],
}
```

## Migration (esboço)

Uma migration só, na ordem em que cada passo depende do anterior:

1. `CREATE TABLE product_variants` + índices + FK `CASCADE` pro produto
2. **Backfill**: um `INSERT ... SELECT` que dá a todo produto existente
   uma variante `Único`, `position = 0`, carregando o `stock_quantity`
   dele. Nenhuma unidade se perde e nenhuma se cria:
   `SUM(product_variants.stock_quantity)` tem que ser igual ao
   `SUM(products.stock_quantity)` de antes
3. `cart_items` ganha `variant_id`, é preenchido pela única variante do
   produto da linha, vira `NOT NULL`, e `product_id` **cai** junto com a
   unicidade antiga
4. `order_items` ganha `variant_id` e `variant_label` (`'Único'` no
   histórico, que é a verdade: era o que se vendia), viram `NOT NULL`, e
   a unicidade passa a ser `[order_id, variant_id]`
5. `products.stock_quantity` **cai** — com ele cai o `CHECK` de não
   negativo, que renasce em `product_variants`
6. `CHECK`s novos (estoque ≥ 0, `position` ≥ 0, rótulo não vazio) e
   `ENABLE ROW LEVEL SECURITY` sem policy, como toda tabela deste repo

## Critérios de aceitação

- [ ] Dado um produto com P/M/G/GG/XGG cadastrados fora de ordem, quando
      leio o produto, então `variants` vem na ordem das `position`, não na
      alfabética (que seria G, GG, M, P, XGG)
- [ ] Dada uma variante com `stockQuantity: 0`, quando leio o produto,
      então ela **está** na lista — riscada pela vitrine, nunca omitida
- [ ] Dado um produto com variantes de 3 e 5 unidades, quando leio o
      produto, então `stockQuantity` do produto é 8
- [ ] Dado um produto criado sem `variants`, quando leio, então ele tem
      exatamente uma variante `Único` — nunca zero
- [ ] Dado `POST /products` com duas variantes de mesmo `label`, então
      `400`/`409` — não duas linhas ambíguas
- [ ] Dado `POST /cart/items` com `{ variantId, quantity }` de uma
      variante de produto `ACTIVE`, então a linha entra com o rótulo
      daquele tamanho
- [ ] Dado um `variantId` de produto `DRAFT`/`ARCHIVED`, ou inexistente,
      então `404` — indistinguíveis, como já é no catálogo
- [ ] Dados P e M do mesmo produto no carrinho, quando leio, então são
      **duas linhas**, cada uma com o seu `variantId` e o seu rótulo
- [ ] Dado checkout de 2 unidades de M, quando o pedido é criado, então o
      estoque de **M** cai 2 e o de P não muda
- [ ] Dado estoque de M insuficiente, quando faço checkout, então `409`
      nomeando a peça (`productName` + `variantLabel`), carrinho intacto e
      estoque inalterado
- [ ] Dados dois checkouts concorrentes da **última unidade de M**, então
      exatamente um pedido é criado e o outro recebe `409`
- [ ] Dado um pedido criado, quando leio seus itens, então cada um traz
      `variantId` e `variantLabel` congelados
- [ ] Dado cancelamento (ou reembolso) de um pedido, então o estoque volta
      **para a variante certa**
- [ ] Dado `PATCH /products/{id}/variants/{variantId}/stock` com 12, então
      só aquela variante passa a ter 12
- [ ] Dada a migration aplicada sobre um banco com produtos e estoque,
      então `SUM(product_variants.stock_quantity)` é igual ao
      `SUM(products.stock_quantity)` de antes, e todo produto tem
      exatamente uma variante `Único`
- [ ] O documento OpenAPI regenerado descreve `variants`,
      `ProductVariantResponse`, o novo `AddCartItemDto` e os campos de
      variante em `OrderItemResponse`

## Estratégia de teste

Unitário onde a regra mora — ordenação e soma em `ProductsService`,
decremento condicional em `StockService`, linha e rótulo em `CartService`,
o `409` nomeado e o restock por variante em `OrdersService`. e2e por cima,
com duas afirmações que só existem sobre um banco de verdade: o checkout
concorrente pela última unidade de um tamanho, e o decremento acertando a
variante certa enquanto a irmã fica parada.

A da migration é diferente das outras: ela não é sobre código, é sobre
dados que já existem. Ela é verificada **executando a migration** contra o
banco de desenvolvimento com catálogo dentro, comparando as duas somas
antes e depois. O resultado fica registrado no Status desta spec, não num
teste — não há suíte que possa reexecutar uma migration já aplicada.

## Edge cases conhecidos

- **Produto arquivado com variante em estoque.** O estoque continua lá e
  continua irrecuperável pela venda: o filtro `ACTIVE` do decremento
  segura. É o comportamento que já existia, só que um nível abaixo.
- **Carrinho antigo apontando pra variante que sumiu.** Não pode
  acontecer na v1: não existe rota que apague variante. Quando existir, o
  `CASCADE` de `cart_items` resolve o carrinho e o `RESTRICT` de
  `order_items` impede apagar uma que já foi vendida — que é exatamente a
  política que a decisão adiada tem que escrever.
- **`itemCount` e o subtotal do carrinho** ([`cart-totals.md`](cart-totals.md))
  continuam somando por linha; duas linhas do mesmo produto em tamanhos
  diferentes somam as duas, que é o certo.
- **Peso do frete continua sendo do produto.** Uma sacola de P e XGG é
  cotada pelo mesmo peso unitário; a diferença real não muda faixa em
  tabela nenhuma que este repo consiga cotar.
- **`position` duplicada** não é erro (não há unicidade nela): duas
  variantes na mesma posição ordenam pelo desempate de `id`. Uma
  unicidade aqui tornaria qualquer reordenação um problema de swap sem
  ganho nenhum enquanto não existe rota de reordenar.

## Decisões adiadas

- **Preço por variante.** É uma coluna nullable em `product_variants` e um
  `??` na leitura no dia em que existir uma loja que cobre mais pelo XGG.
  Hoje seria generalidade inventada antes da hora, e o preço passaria a ter
  dois lugares onde morar sem que nenhum código precisasse do segundo.
- **Renomear / reordenar / remover variante.** Remover exige política pro
  que já foi vendido; renomear é o motivo de `variant_label` já ser
  snapshot, então o dia em que a rota existir o histórico já está
  protegido.
- **Cor, e a matriz tamanho × cor.** Muda a modelagem (opções e valores,
  SKU composto), não só a tabela. Entra quando uma loja real vender.
- **Estoque por variante no e-mail do pedido.** O template mostra nome e
  quantidade; acrescentar o tamanho é uma linha, mas mexe numa spec que
  não é esta.
