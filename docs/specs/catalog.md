# Spec: catalog

## Status

`implementado`

Entregue de uma vez: schema (com RLS deny-all na própria migration),
serviços de domínio unit-first, superfície HTTP e e2e. Este módulo também
fechou o critério de RBAC (403) que estava aberto na
[spec de auth](auth.md) — primeira rota de domínio protegida por
permissão.

### Buracos de cobertura conhecidos

- O `OptionalJwtAuthGuard` (auth opcional nas leituras públicas) não tem
  teste unitário próprio — os três caminhos (anônimo, token válido,
  token inválido oferecido) são exercidos pelo e2e no nível HTTP.

## Objetivo

Expor o catálogo da loja — produtos e categorias — com leitura pública
pra qualquer front-end e escrita restrita ao back-office via RBAC, mais
um controle simples de estoque (quantidade por produto, decremento
atômico) que o módulo `orders` vai consumir no checkout.

## Escopo

### Entra

- CRUD de produto (nome, slug, descrição, preço, imagens por URL,
  status, estoque)
- CRUD de categoria (flat, sem hierarquia) e associação
  produto↔categoria (N:N)
- Listagem pública paginada com filtro por categoria e busca simples
  por nome (`ILIKE`, sem motor de busca)
- Ciclo de vida do produto: `DRAFT → ACTIVE → ARCHIVED`. O público só
  vê `ACTIVE`; rascunho e arquivado exigem `products.read`
- Controle simples de estoque: coluna `stockQuantity` no produto,
  ajuste absoluto pelo back-office, e uma operação interna de
  decremento condicional atômico pra `orders` usar depois
- Proteção das rotas de escrita com `@RequirePermissions(...)` — este
  módulo fecha o critério de RBAC (403) que ficou aberto na
  [spec de auth](auth.md#critérios-de-aceitação)

### Não entra (fica pra depois)

- Variantes de produto (tamanho/cor com SKU próprio) — v1: um produto
  = uma unidade vendável, um preço, um estoque
- Categorias aninhadas (`parentId`) — v1 é flat
- Upload/armazenamento de imagem — v1 guarda só URLs (string[]);
  storage (S3/Supabase Storage) entra quando houver painel admin real
- Reserva de estoque (hold no carrinho) e ledger de movimentações —
  v1 só decrementa no checkout; ver "Decisões adiadas"
- Multi-moeda — preço é centavos de uma moeda única (BRL)
- Cupons (têm permissões previstas, mas são feature própria)

## Regras de negócio / invariantes

- **Preço em centavos, inteiro, > 0** (`priceCents Int`). Nunca float —
  aritmética de dinheiro em float é bug esperando data pra acontecer.
- **Estoque nunca fica negativo.** Decremento é um `UPDATE ... WHERE
  stock_quantity >= n` condicional e atômico no banco — a corrida de
  dois checkouts pelo último item é resolvida pelo Postgres, não por
  check-then-write na aplicação. Se não afetou linha, a operação
  falhou e quem chamou trata.
- **O público só enxerga produto `ACTIVE`.** Listagem e detalhe
  públicos filtram por status; ver `DRAFT`/`ARCHIVED` (via
  `?status=`) exige `products.read` — pra isso que a permissão de
  leitura existe, já que a vitrine é pública.
- **`DELETE` de produto arquiva, não apaga.** Pedido vai referenciar
  produto; apagar a linha quebraria histórico. `ARCHIVED` sai da
  vitrine e recusa novas vendas, mas a linha fica.
- **Slug único por tabela** (produtos e categorias separadamente),
  gerado do nome quando não enviado, com sufixo em colisão de
  auto-geração; slug enviado explicitamente que colide → `409`.
- **Escrita exige permissão, não papel.** Rotas de escrita usam
  `@RequirePermissions(PERMISSIONS.PRODUCTS_*)`. Categoria reusa as
  permissões `products.*` — catálogo é uma capacidade só; granularizar
  categoria em permissão própria é decisão adiada.
- **Autenticado sem permissão → 403; sem token em rota protegida →
  401.** `customer` tem catálogo de permissões vazio, então qualquer
  escrita dele é 403 — exatamente o critério pendente do auth.
- **Toda tabela nova nasce com RLS deny-all na própria migration**
  (produtos, categorias e a join table) — regra do projeto pós-auth:
  RLS não herda, e o Supabase expõe tabela nova pra anon key.
- **`orders` conhece `catalog` por interface, nunca o contrário.**
  O decremento de estoque é método de serviço exportado pelo
  `CatalogModule` (ex: `StockService.decrement(productId, qty)`);
  nenhum import de `orders` aqui dentro.

## Modelo de dados (esboço Prisma)

```prisma
enum ProductStatus {
  DRAFT
  ACTIVE
  ARCHIVED
}

model Product {
  id            String        @id @default(uuid())
  name          String
  slug          String        @unique
  description   String?
  priceCents    Int           @map("price_cents")
  imageUrls     String[]      @map("image_urls")
  status        ProductStatus @default(DRAFT)
  stockQuantity Int           @default(0) @map("stock_quantity")

  categories ProductCategory[]

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([status])
  @@map("products")
}

model Category {
  id          String  @id @default(uuid())
  name        String
  slug        String  @unique
  description String?

  products ProductCategory[]

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("categories")
}

// Join table explícita (não a implícita do Prisma) pra controlar o nome
// da tabela e garantir a migration de RLS nela também.
model ProductCategory {
  productId  String   @map("product_id")
  categoryId String   @map("category_id")
  product    Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  category   Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@id([productId, categoryId])
  @@index([categoryId])
  @@map("product_categories")
}
```

Deletar categoria **desassocia** os produtos (cascade só na join
table) — produto órfão de categoria é válido.

## Superfície da API

| Método | Rota                       | Descrição                                              | Auth                              |
| ------ | -------------------------- | ------------------------------------------------------ | --------------------------------- |
| GET    | `/products`                | Lista paginada; filtros `category`, `search`, `status` | público (`status=` exige `products.read`) |
| GET    | `/products/:idOrSlug`      | Detalhe (só `ACTIVE` sem permissão)                    | público (`products.read` p/ não-ativo) |
| POST   | `/products`                | Cria produto (nasce `DRAFT` por default)               | `products.create`                 |
| PATCH  | `/products/:id`            | Atualiza campos, incl. `status` e categorias           | `products.update`                 |
| DELETE | `/products/:id`            | Arquiva (soft delete)                                  | `products.delete`                 |
| PATCH  | `/products/:id/stock`      | Define quantidade absoluta (acerto de inventário)      | `products.update`                 |
| GET    | `/categories`              | Lista todas (categoria não tem status)                 | público                           |
| GET    | `/categories/:slug`        | Detalhe                                                | público                           |
| POST   | `/categories`              | Cria categoria                                         | `products.create`                 |
| PATCH  | `/categories/:id`          | Atualiza                                               | `products.update`                 |
| DELETE | `/categories/:id`          | Remove (hard delete; desassocia produtos)              | `products.delete`                 |

### DTOs (esboço)

```ts
class CreateProductDto {
  name: string;
  slug?: string; // gerado do nome se ausente
  description?: string;
  priceCents: number; // int > 0
  imageUrls?: string[];
  status?: ProductStatus; // default DRAFT
  stockQuantity?: number; // int >= 0, default 0
  weightGrams?: number; // int >= 1; adicionado por shipping.md
  categoryIds?: string[];
}

class UpdateProductDto extends PartialType(CreateProductDto) {}

class SetStockDto {
  quantity: number; // int >= 0, absoluto
}

class ListProductsQueryDto {
  page?: number; // default 1
  perPage?: number; // default 20, máx 100
  category?: string; // slug da categoria
  search?: string; // match parcial no nome
  status?: ProductStatus | 'all'; // exige products.read
}

class CreateCategoryDto {
  name: string;
  slug?: string;
  description?: string;
}
```

Resposta de listagem: `{ items, total, page, perPage }`.

> **Emenda de [`shipping.md`](shipping.md).** `Product` ganhou
> `weightGrams` (opcional, int >= 1) pra cotação de frete, e ele entra
> nos dois DTOs de escrita acima. Produto sem peso é cotado pelo
> `SHIPPING_DEFAULT_WEIGHT_GRAMS` do ambiente — a loja paga a diferença
> quando o palpite é baixo, então vale preencher. Esta seção tinha ficado
> desatualizada: o campo estava no código e specado lá, mas não aqui, que
> é a spec autoritativa destas rotas. Levantado pela auditoria de rotas em
> [`openapi.md`](openapi.md).

## Critérios de aceitação

Todos cobertos por `test/catalog.e2e-spec.ts` no nível HTTP (os de
estoque concorrente via `StockService` contra o banco real), mais os
unitários ao lado do código.

- [x] Dado um admin autenticado, quando cria um produto válido via
      `POST /products`, então recebe `201` com o produto criado com
      status `DRAFT` e slug gerado do nome.
- [x] Dado um produto com `priceCents <= 0` ou não-inteiro, quando
      tento criar, então recebo `400` e nada é persistido.
- [x] Dado um slug já existente enviado explicitamente, quando tento
      criar outro produto com ele, então recebo `409`.
- [x] Dado um usuário `customer` autenticado (token válido), quando
      chama `POST /products`, então recebe `403` — fecha o critério de
      RBAC pendente em [auth.md](auth.md).
- [x] Dado um request sem token, quando chama `POST /products`, então
      recebe `401`.
- [x] Dado um `operator` (tem `products.read`, não tem
      `products.create`), quando lista com `?status=all` recebe `200`
      incluindo rascunhos, e quando tenta `POST /products` recebe
      `403`.
- [x] Dado um catálogo com produtos `DRAFT`, `ACTIVE` e `ARCHIVED`,
      quando um cliente anônimo chama `GET /products`, então só os
      `ACTIVE` aparecem, paginados.
- [x] Dado um cliente anônimo, quando pede `GET /products?status=all`,
      então recebe `403` (filtro de status é privilégio de leitura do
      back-office).
- [x] Dado um produto associado a uma categoria, quando listo
      `GET /products?category=<slug>`, então só produtos daquela
      categoria voltam.
- [x] Dado um produto `ACTIVE`, quando chamo `DELETE /products/:id`
      com `products.delete`, então ele vira `ARCHIVED` e some da
      listagem pública, mas `GET` com `products.read` ainda o encontra.
- [x] Dado um produto com estoque 5, quando o back-office define
      estoque 12 via `PATCH /products/:id/stock`, então a quantidade
      passa a 12; quantidade negativa → `400`.
- [x] Dado um produto com estoque 1, quando dois decrementos
      concorrentes de 1 unidade executam, então exatamente um sucede e
      o estoque termina em 0, nunca negativo (teste do serviço interno
      contra o banco real).
- [x] Dado estoque insuficiente, quando `StockService.decrement` é
      chamado, então retorna falha sem alterar nada.
- [x] Dado uma categoria com produtos associados, quando ela é
      deletada, então os produtos continuam existindo, sem a
      associação.
- [x] Dado qualquer tabela nova deste módulo, quando consultada com a
      anon key do Supabase, então nada é retornado (RLS deny-all —
      na própria migration, mesmo padrão do auth; confirmado após o
      deploy pelo security advisor do Supabase: as três tabelas novas
      aparecem como "RLS enabled, no policies", que é o estado
      desejado).

## Edge cases conhecidos

- Corrida de dois checkouts pelo último item — resolvida pelo
  decremento condicional atômico (critério acima).
- `PATCH` de estoque absoluto concorrente com decremento de checkout
  pode sobrescrever a venda (last-write-wins). Aceito na v1: acerto de
  inventário é operação rara de back-office; ledger de movimentações
  resolveria e está adiado.
- Renomear slug de produto quebra link externo salvo — aceito na v1
  (o `:idOrSlug` aceita o id imutável como alternativa).
- Produto sem categoria nenhuma é válido (vitrine "sem categoria").
- `perPage` gigante → clampado em 100; `page` além do fim → lista
  vazia, não erro.
- Auto-geração de slug que colide (dois produtos "Camiseta Azul") →
  sufixo (`camiseta-azul-2`), não erro — `409` é só pra slug
  explícito.

## Decisões adiadas

- **Variantes** (tamanho/cor, SKU por variante). Quando entrarem, o
  estoque desce do produto pra variante — a interface
  `StockService.decrement(productId, qty)` vira
  `decrement(variantId, qty)`; `orders` referenciará o id vendável, o
  que contém a mudança.
- **Categorias aninhadas** — adicionar `parentId` auto-referente é
  migration pequena; o custo real (query de subárvore na listagem)
  fica pra quando um front precisar de árvore de navegação.
- **Reserva de estoque / ledger de movimentações** — v1 decrementa no
  checkout (momento exato é decisão da spec de `orders`). Sem hold de
  carrinho: carrinho abandonado não pode segurar estoque sem TTL, e
  TTL exige job em background, que é pós-v1.
- **Permissões próprias de categoria** (`categories.*`) — hoje reusa
  `products.*`; separar só se surgir um papel que gerencia um mas não
  o outro.
- **Upload de imagem** — v1 aceita URLs prontas.
- **Busca de verdade** (Elastic/Meilisearch) — `ILIKE` no nome basta
  pra v1, já registrado como fora de escopo no `claude/context.md`.
