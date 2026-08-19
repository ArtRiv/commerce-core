# Spec: orders (carrinho & pedidos)

## Status

`implementado`

Decisões estruturais alinhadas antes desta spec: carrinho e pedido como
estruturas separadas; estoque decrementa no checkout; cancelamento só de
pedido `CREATED` na v1; carrinho exige autenticação.

Entregue de uma vez: schema (com RLS deny-all e CHECKs na própria
migration), contrato do catálogo ampliado (`decrement` transacional,
`restock`, `findByIds`), módulo `payments` mínimo (token +
`FakePaymentProvider`), serviços de domínio unit-first, superfície HTTP
e e2e (`test/orders.e2e-spec.ts`), incluindo os dois critérios de
concorrência contra o banco real.

Um refinamento sobre o desenho original, vindo do próprio critério de
aceitação: cancelar pedido alheio distingue **visibilidade** de
**capacidade** — quem não enxerga o pedido leva `404`; quem enxerga
(operator, via `orders.read`) mas não pode cancelar leva `403`.

### Buracos de cobertura conhecidos

- O único provider exercido é o `FakePaymentProvider`, que não falha por
  construção — o caminho "provider falhou depois da transação de
  checkout" (pedido sem `paymentRef`) é inalcançável e, portanto, não
  testado. Vira caso real (e testável) com o Stripe. **Fechado** por
  [`payments.md`](payments.md), que cobre a falha do provedor no
  checkout.
- O critério de RLS foi verificado pelo security advisor do Supabase
  após o deploy da migration (as quatro tabelas novas aparecem como
  "RLS enabled, no policies", o estado desejado), não por uma sonda
  HTTP com a anon key dentro da suíte — mesma postura do catalog.

## Objetivo

Fechar o ciclo de compra: o cliente monta um carrinho, faz checkout e o
pedido nasce como registro imutável (preço congelado no momento da
compra), seguindo o ciclo `CREATED → PAID → SHIPPED → DELIVERED`. É o
módulo orquestrador — consome `catalog` (produto e estoque) e `payments`
(interface `PaymentProvider`, stub na v1), sem nunca tocar as tabelas
dos outros módulos.

## Escopo

### Entra

- Carrinho por usuário autenticado: um carrinho por usuário, criado
  lazy no primeiro item; adicionar/ajustar/remover item, esvaziar
- Checkout: converte o carrinho em pedido numa transação — snapshot de
  nome e preço nos itens, decremento atômico de estoque, carrinho
  consumido; falha de estoque aborta tudo com `409`
- Ciclo de vida do pedido com transições explícitas e carimbo de data
  por transição (`paidAt`, `shippedAt`, `deliveredAt`, `cancelledAt`)
- Cancelamento de pedido `CREATED` (cliente no próprio pedido;
  `orders.cancel` em qualquer um), devolvendo o estoque
- Ownership: cliente enxerga e age só nos próprios pedidos (escopo por
  query no service); `orders.read` enxerga tudo, com filtros
- Módulo `payments` mínimo: só a interface `PaymentProvider` (token de
  injeção) + `FakePaymentProvider`, mesmo padrão do módulo `mail`
- Endereço de entrega como snapshot no pedido (objeto no DTO de
  checkout, colunas desnormalizadas na tabela)
- RLS deny-all nas quatro tabelas novas, na própria migration

### Não entra (fica pra depois)

- Carrinho de convidado (guest) e merge no login — v1 exige login antes
  de adicionar ao carrinho; a chave `sessionId` entra depois sem quebrar
  este modelo
- Reserva de estoque com TTL — decisão herdada do catalog: sem job em
  background não há como expirar reserva; pedido `CREATED` abandonado
  segura estoque até alguém cancelar (mitigação: cancelar devolve
  estoque, e o operador pode cancelar pedidos velhos manualmente; o job
  de TTL pós-v1 só automatiza esse caminho que já existe)
- Reembolso — cancelar pedido pago significa devolver dinheiro, e isso
  pertence ao módulo de payments real. A permissão `orders.refund` já
  existe e fica reservada; a transição entra junto com o Stripe.
  **Entregue depois**, em [`payments.md`](payments.md), como
  `PAID → REFUNDED` (status próprio, não `CANCELLED`: dinheiro que
  voltou é evento diferente de pedido abandonado)
- Stripe de verdade — v1 usa `FakePaymentProvider`; o desenho do
  webhook (verificação de assinatura, idempotência de retry) é da spec
  de payments
- Frete real (`ShippingProvider`, cálculo de frete) — v1 só guarda o
  endereço; a seta `orders → shipping` do diagrama continua alvo.
  **Entregue depois** em [`shipping.md`](shipping.md): o checkout passa a
  exigir a opção de frete escolhida, e `totalCents` passa a incluí-la
- Cupons, address book do usuário, trava de preço no carrinho
  (carrinho mostra sempre preço vivo do catálogo)

## Regras de negócio / invariantes

- **Carrinho é mutável e sem valor financeiro.** `cart_items` guarda só
  `productId + quantity`; preço exibido é sempre leitura viva do
  catálogo. Carrinho nunca "envelhece" — quem envelhece é o preço, e o
  cliente vê o atual.
- **Pedido é registro imutável.** `order_items` congela `productName` e
  `unitPriceCents` no instante do checkout. Mudança de preço no catálogo
  depois da compra nunca altera pedido existente. Nenhum endpoint edita
  itens de pedido.

  > **Atualizado por [`shipping.md`](shipping.md).** `totalCents` era a
  > soma `unitPriceCents × quantity` dos itens; hoje essa soma é
  > `itemsSubtotalCents`, e **`totalCents` é o total cobrado**
  > (`itemsSubtotalCents + shippingCents`), com a identidade garantida por
  > `CHECK` no banco. Como `payments` cobra `order.totalCents`, é essa
  > redefinição que faz o frete chegar ao cartão sem `payments` saber que
  > frete existe. Pedidos anteriores ao frete foram backfillados de forma
  > aritmeticamente neutra (`itemsSubtotalCents = totalCents`,
  > `shippingCents = 0`), então nenhum registro financeiro mudou de valor.
- **`order_items.productId` é FK real com `onDelete: Restrict`** —
  seguro porque o catálogo nunca apaga produto, só arquiva (invariante
  do catalog). O snapshot é o que se exibe; a FK é rastreabilidade.
- **Estoque decrementa no checkout, dentro da transação que cria o
  pedido.** Cada item passa pelo `StockService.decrement` (condicional,
  atômico); qualquer falha — estoque insuficiente ou produto não-`ACTIVE`
  — aborta a transação inteira: `409` apontando os `productId`
  problemáticos, nenhum pedido criado, nenhum estoque alterado,
  carrinho intacto.
- **Checkout consome o carrinho atomicamente.** A limpeza dos itens do
  carrinho acontece na mesma transação, com verificação de contagem —
  duplo-submit concorrente do checkout produz exatamente um pedido; o
  outro falha com `409` de carrinho vazio.
- **Máquina de estados com transições explícitas:**

  ```
  CREATED ──→ PAID ──→ SHIPPED ──→ DELIVERED
     │         │
     │         └──→ REFUNDED
     └──→ CANCELLED
  ```

  | Transição             | Quem dispara                                      |
  | --------------------- | ------------------------------------------------- |
  | checkout → `CREATED`  | cliente (próprio carrinho)                        |
  | `CREATED → PAID`      | confirmação de pagamento (webhook do Stripe ou `orders.update_status` pro registro manual) |
  | `PAID → SHIPPED`      | `orders.update_status`                            |
  | `SHIPPED → DELIVERED` | `orders.update_status`                            |
  | `CREATED → CANCELLED` | cliente (próprio pedido) ou `orders.cancel`       |
  | `PAID → REFUNDED`     | `orders.refund` — desenho em [`payments.md`](payments.md) |

  Qualquer transição fora da tabela → `409`. `SHIPPED` e `DELIVERED`
  nunca são canceláveis. Cada transição preenche seu timestamp — é a
  trilha de auditoria da v1, sem tabela de eventos.
- **`markPaid` é o seam do pagamento.** O método de domínio
  `OrdersService.markPaid(orderId)` é o único caminho `CREATED → PAID`.
  Na v1 ele é exposto por `POST /orders/:id/mark-paid` atrás de
  `orders.update_status` (que de quebra serve como registro manual de
  pagamento — transferência, Pix); quando o Stripe chegar, o webhook
  chama o mesmo método e a rota manual continua existindo. Orders não
  muda quando o provedor real entrar.
- **`PaymentProvider` fica no módulo `payments`, atrás de token de
  injeção** (mesmo padrão do `MailService`): o checkout chama
  `createPayment({ orderId, amountCents })` e guarda o `providerRef`
  devolvido no pedido. A chamada acontece **depois** da transação de
  banco (chamada externa dentro de transação segura conexão e trava
  lock); o `FakePaymentProvider` é infalível, e o tratamento de falha
  do provedor real é desenho da spec de payments.
- **Ownership por escopo de query no service, não por guard.** Checar
  dono exige carregar o recurso, o que guard faz mal. Sem `orders.read`,
  toda query é silenciosamente escopada ao `userId` do caller — pedir o
  pedido de outro usuário responde **`404`, não `403`** (não confirma
  que o id existe). Com `orders.read`, enxerga tudo.
- **Cancelar devolve estoque** via `StockService.restock(productId,
  qty)` — incremento incondicional (funciona em produto arquivado:
  as unidades voltaram fisicamente à prateleira).
- **Contrato com o catálogo cresce, mas não vaza:** `decrement` passa a
  aceitar um client de transação opcional (pro checkout ser atômico) e
  `restock` é novo. `orders` continua sem tocar tabela de catálogo.
- **Endereço é snapshot, como preço.** O DTO de checkout carrega o
  endereço; o pedido guarda colunas desnormalizadas. Sem address book
  na v1.
- **Toda tabela nova nasce com RLS deny-all na própria migration**
  (`carts`, `cart_items`, `orders`, `order_items`) — regra do projeto.
- **Erro segue a convenção:** input malformado → `400`; recurso
  inexistente (ou de outro dono) → `404`; sem token → `401`; sem
  permissão → `403`; requisição válida que conflita com o estado atual
  (transição inválida, estoque insuficiente, carrinho vazio) → `409`.

## Modelo de dados (esboço Prisma)

```prisma
enum OrderStatus {
  CREATED
  PAID
  SHIPPED
  DELIVERED
  CANCELLED
}

model Cart {
  id     String @id @default(uuid())
  userId String @unique @map("user_id")
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  items CartItem[]

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("carts")
}

model CartItem {
  id        String  @id @default(uuid())
  cartId    String  @map("cart_id")
  cart      Cart    @relation(fields: [cartId], references: [id], onDelete: Cascade)
  productId String  @map("product_id")
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  quantity  Int

  @@unique([cartId, productId])
  @@map("cart_items")
}

model Order {
  id     String      @id @default(uuid())
  userId String      @map("user_id")
  user   User        @relation(fields: [userId], references: [id])
  status OrderStatus @default(CREATED)

  totalCents Int     @map("total_cents")
  paymentRef String? @map("payment_ref")

  // Snapshot do endereço de entrega no checkout (sem address book na v1).
  shippingLine1      String  @map("shipping_line1")
  shippingLine2      String? @map("shipping_line2")
  shippingCity       String  @map("shipping_city")
  shippingState      String  @map("shipping_state")
  shippingPostalCode String  @map("shipping_postal_code")

  paidAt      DateTime? @map("paid_at")
  shippedAt   DateTime? @map("shipped_at")
  deliveredAt DateTime? @map("delivered_at")
  cancelledAt DateTime? @map("cancelled_at")

  items OrderItem[]

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([userId])
  @@index([status])
  @@map("orders")
}

model OrderItem {
  id      String @id @default(uuid())
  orderId String @map("order_id")
  order   Order  @relation(fields: [orderId], references: [id], onDelete: Cascade)

  // FK de rastreabilidade; o que se exibe é o snapshot.
  productId String  @map("product_id")
  product   Product @relation(fields: [productId], references: [id], onDelete: Restrict)

  productName    String @map("product_name")
  unitPriceCents Int    @map("unit_price_cents")
  quantity       Int

  @@unique([orderId, productId])
  @@map("order_items")
}
```

`CartItem` cascateia na deleção do produto por higiene teórica (produto
não é deletado na prática); `OrderItem` restringe — histórico financeiro
segura a linha do produto pra sempre.

## Superfície da API

Carrinho — todas exigem autenticação; o carrinho é sempre o do caller:

| Método | Rota                       | Descrição                                            | Auth        |
| ------ | -------------------------- | ---------------------------------------------------- | ----------- |
| GET    | `/cart`                    | Carrinho próprio, itens com dados vivos do catálogo  | autenticado |
| POST   | `/cart/items`              | Adiciona item (produto repetido incrementa a qtde)   | autenticado |
| PATCH  | `/cart/items/:productId`   | Define quantidade absoluta do item                   | autenticado |
| DELETE | `/cart/items/:productId`   | Remove o item                                        | autenticado |
| DELETE | `/cart`                    | Esvazia o carrinho                                   | autenticado |

Pedidos:

| Método | Rota                      | Descrição                                        | Auth                             |
| ------ | ------------------------- | ------------------------------------------------ | -------------------------------- |
| POST   | `/orders`                 | Checkout do carrinho próprio (endereço no body)  | autenticado                      |
| GET    | `/orders`                 | Lista paginada: próprios; tudo com `orders.read` (filtros `status`, `userId`) | autenticado |
| GET    | `/orders/:id`             | Detalhe: próprio; qualquer um com `orders.read`  | autenticado                      |
| POST   | `/orders/:id/cancel`      | `CREATED → CANCELLED`, devolve estoque           | dono (só próprio) ou `orders.cancel` |
| POST   | `/orders/:id/pay`         | (Re)emite a sessão de pagamento — desenho em [`payments.md`](payments.md) | dono, ou `orders.update_status` |
| POST   | `/orders/:id/mark-paid`   | `CREATED → PAID` (seam do webhook e do registro manual) | `orders.update_status`     |
| POST   | `/orders/:id/refund`      | `PAID → REFUNDED` — desenho em [`payments.md`](payments.md) | `orders.refund`         |
| POST   | `/orders/:id/ship`        | `PAID → SHIPPED`                                 | `orders.update_status`           |
| POST   | `/orders/:id/deliver`     | `SHIPPED → DELIVERED`                            | `orders.update_status`           |

Transições como verbos explícitos (não `PATCH status`) — cada uma valida
seu estado de origem e tem semântica e permissão próprias; nada de
tabela de transição no DTO.

### DTOs (esboço)

```ts
class AddCartItemDto {
  productId: string; // uuid; produto precisa existir e estar ACTIVE
  quantity: number; // int >= 1, máx 999
}

class SetCartItemQuantityDto {
  quantity: number; // int >= 1, máx 999
}

class ShippingAddressDto {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

class CheckoutDto {
  shippingAddress: ShippingAddressDto;
}

class ListOrdersQueryDto {
  page?: number; // default 1
  perPage?: number; // default 20, máx 100
  status?: OrderStatus;
  userId?: string; // exige orders.read
}
```

Resposta do carrinho: itens com `{ productId, quantity, product:
{ name, slug, priceCents, status, stockQuantity } }` — dados vivos; o
front deriva avisos ("saiu de linha", "estoque menor que a quantidade").
Resposta de listagem de pedidos: `{ items, total, page, perPage }`.

### Contrato com payments (v1)

Esta é a forma que orders entregou. A interface cresceu em
[`payments.md`](payments.md) (sessão com modo, reembolso, expiração e
parsing de webhook), mas o que orders chama no checkout continua sendo
`createPayment` — o call site não mudou de forma.

```ts
// src/payments — só isto na v1
interface PaymentProvider {
  createPayment(input: {
    orderId: string;
    amountCents: number;
  }): Promise<{ providerRef: string }>;
}
// + PAYMENT_PROVIDER (token) + FakePaymentProvider (providerRef "fake_<uuid>")
```

## Critérios de aceitação

Carrinho:

- [x] Dado um usuário autenticado sem carrinho, quando adiciona um
      produto `ACTIVE` com quantidade 2, então recebe o carrinho criado
      (lazy) com o item; sem token → `401`.
- [x] Dado um item já no carrinho, quando o mesmo produto é adicionado
      de novo, então a quantidade soma — não duplica linha.
- [x] Dado um produto `DRAFT`, `ARCHIVED` ou inexistente, quando tento
      adicionar ao carrinho, então recebo `404` e nada muda (o público
      não distingue rascunho de inexistente).
- [x] Dado quantidade 0, negativa ou não-inteira, quando adiciono ou
      ajusto item, então recebo `400`.
- [x] Dado um item no carrinho, quando `PATCH` define quantidade 5,
      então a quantidade é 5 (absoluta); quando `DELETE` no item, ele
      some; quando `DELETE /cart`, o carrinho esvazia.
- [x] Dado o carrinho do usuário A, quando o usuário B consulta
      `GET /cart`, então vê só o próprio carrinho — nunca o de A.
- [x] Dado um produto no carrinho, quando o preço muda no catálogo,
      então `GET /cart` mostra o preço novo (preço vivo, sem trava).

Checkout:

- [x] Dado um carrinho válido, quando faço checkout com endereço, então
      recebo `201` com pedido `CREATED`: itens com snapshot de nome e
      preço, `totalCents` = soma dos subtotais, estoque decrementado,
      carrinho vazio e `paymentRef` preenchido pelo provider fake.
      (Depois de [`shipping.md`](shipping.md) o checkout também exige
      `shippingOptionCode`/`quotedShippingCents`, e a soma dos subtotais
      passa a ser `itemsSubtotalCents`.)
- [x] Dado um pedido criado, quando o preço do produto muda no
      catálogo, então o pedido mantém o preço do momento da compra.
- [x] Dado um item com estoque insuficiente (ou produto que virou
      não-`ACTIVE`), quando faço checkout, então recebo `409` apontando
      os `productId` problemáticos e nada mudou: sem pedido, estoque
      intacto, carrinho intacto.
- [x] Dado um carrinho vazio (ou inexistente), quando faço checkout,
      então recebo `409`.
- [x] Dado dois checkouts concorrentes do mesmo carrinho, quando ambos
      executam, então exatamente um pedido é criado — o outro falha com
      `409` (carrinho consumido atomicamente).

Ciclo de vida:

- [x] Dado um pedido `CREATED`, quando um operator chama `mark-paid`,
      então vira `PAID` com `paidAt` preenchido; um customer chamando a
      mesma rota recebe `403`.
- [x] Dado um pedido `PAID`, quando `ship`, vira `SHIPPED`; dado
      `SHIPPED`, quando `deliver`, vira `DELIVERED` — cada um com seu
      timestamp; transição com estado de origem errado (ex: `ship` em
      `CREATED`, `mark-paid` em `CANCELLED`) → `409`.
- [x] Dado um pedido `CREATED` do próprio cliente, quando ele cancela,
      então vira `CANCELLED` e o estoque dos itens é devolvido.
- [x] Dado um pedido `PAID` do próprio cliente, quando ele tenta
      cancelar, então recebe `409` (devolver dinheiro é rota própria,
      atrás de `orders.refund` — ver [`payments.md`](payments.md));
      cancelar `SHIPPED`/`DELIVERED` → `409` mesmo com `orders.cancel`.
- [x] Dado um pedido `CREATED` de outro cliente, quando um admin (tem
      `orders.cancel`) cancela, então funciona — operator (não tem) →
      `403`.

Ownership / listagem:

- [x] Dado um pedido do usuário A, quando o usuário B pede
      `GET /orders/:id`, então recebe `404` (não `403` — não confirma
      existência); um operator com `orders.read` recebe `200`.
- [x] Dado vários usuários com pedidos, quando um customer lista
      `GET /orders`, então vê só os próprios, paginados; um operator vê
      todos e pode filtrar por `status` e `userId` (filtro `userId` sem
      `orders.read` → `403`).

Infra:

- [x] Dado qualquer tabela nova deste módulo, quando consultada com a
      anon key do Supabase, então nada é retornado (RLS deny-all na
      própria migration, mesmo padrão de auth/catalog).

## Edge cases conhecidos

- Produto arquivado com item ainda em carrinhos: `GET /cart` mostra o
  status vivo (front avisa), e o checkout falha com `409` até o cliente
  remover o item. Não há limpeza automática de carrinho.
- Pedido `CREATED` abandonado segura estoque indefinidamente (sem TTL na
  v1, decisão consciente) — caminho de escape: cancelamento manual, que
  devolve o estoque.
- `mark-paid` duas vezes → `409` na segunda (estado já é `PAID`). A
  idempotência de retry de webhook (Stripe reenvia) é problema do
  adapter de webhook na spec de payments, não do domínio.
- Falha do `PaymentProvider` depois da transação de checkout → pedido
  existe sem `paymentRef`. Com o fake é impossível; o tratamento real
  (retry, reconciliação) entra com o Stripe. ~~Registrado, não
  resolvido.~~ **Resolvido em [`payments.md`](payments.md)**: o checkout
  passa a tolerar a falha (pedido nasce sem sessão) e
  `POST /orders/:id/pay` é o caminho de recuperação.
- Cancelamento devolvendo estoque de produto `ARCHIVED` → incremento
  acontece mesmo assim (unidades físicas voltaram); o produto continua
  fora da vitrine e recusando vendas novas.
- Usuário deletado cascateia o carrinho (`Cascade`) mas não os pedidos —
  pedido é registro financeiro; deleção de usuário com pedidos fica
  `Restrict` implícito pelo FK default do Prisma na v1 (deleção de
  conta nem existe como feature ainda).
- `userId` no filtro de listagem que não existe → lista vazia, não
  `404`.
- Dois carrinhos pro mesmo usuário são impossíveis por unique em
  `userId` — corrida de dupla criação lazy resolvida por upsert/retry
  no unique, não por check-then-write.

## Decisões adiadas

- **Guest cart** — chave `sessionId` ao lado de `userId` + merge no
  login; nada no modelo atual bloqueia.
- **Reserva com TTL** — job em background (BullMQ) pós-v1 cancelando
  `CREATED` velhos automaticamente; usa o mesmo caminho de cancelamento
  já existente.
- **Reembolso** (`orders.refund`) — entrou com o módulo payments real,
  como `PAID → REFUNDED`: ver [`payments.md`](payments.md).
- **Idempotency key no checkout** (header `Idempotency-Key`) — o
  consumo atômico do carrinho já impede pedido duplo do mesmo carrinho;
  chave explícita vira necessidade quando houver retry de cliente
  mobile/rede ruim.
- **Trava de preço no carrinho** ("preço garantido por X minutos") —
  exige TTL também; v1 mostra preço vivo e congela só no checkout.
- **Address book** (endereços salvos do usuário) — quando houver
  frontend de conta; o snapshot no pedido não muda com isso.
- **Histórico de transições em tabela própria** (`order_events`) — os
  timestamps por transição cobrem a v1; tabela de eventos entra se/quando
  webhooks de domínio (`order.created`…) entrarem no roadmap pós-v1.
