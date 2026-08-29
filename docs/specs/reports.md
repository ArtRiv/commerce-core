# Spec: reports (as quatro perguntas do painel)

## Status

`implementado`

**545 testes unitários** (43 novos) e **46 e2e num arquivo próprio**, com
`lint:check`, `typecheck` e `build` limpos e o `openapi.json` regerado —
**46 operações**, quatro a mais, num nono controller.

A divisão entre as duas suítes não é arbitrária. Os unitários provam o que é
**ligado** a cada consulta — e o mais importante deles lê os parâmetros de
volta para afirmar que `CREATED`, `CANCELLED` e `REFUNDED` nunca chegam ao
banco como algo a contar. Isso é uma afirmação sobre a construção da query, e
mock nenhum a esconde.

O que só um Postgres de verdade falsifica é o SQL, e três coisas em especial:
que uma venda de 01:30 UTC do dia 1º de setembro cai no bucket de **agosto**
para uma loja em São Paulo; que um mês sem venda volta como zeros e não como
buraco; e que "não vende" é o complemento exato de "vendeu", contra as mesmas
linhas.

Os pedidos do e2e são escritos direto no banco, de propósito: `paidAt` é
carimbado pela máquina de estados e nenhuma rota o retroage, então uma suíte
dirigindo checkout só conseguiria relatar sobre hoje.

## Objetivo

`reports.read` está no catálogo de permissões desde o auth e não tem uma única
rota atrás dela. O painel da AVESSO já está construído e faz **quatro**
perguntas que hoje nenhuma rota responde — quanto de cada peça saiu, quanto
entrou por semana e por mês, quantas unidades estão paradas em carrinho agora,
e quais peças não vendem. Esta spec abre exatamente essas quatro e nada mais.

É o item 3 de [`../admin-api.md`](../admin-api.md) — o último da ordem sugerida
ali, e o documento avisa por quê: _"faturamento derivado é fácil de calcular
errado"_. Metade desta spec é, portanto, sobre **o que conta como venda**, não
sobre rota.

## Escopo

### Entra

- `GET /reports/product-sales` — unidades e receita por peça, num período
- `GET /reports/revenue` — receita por semana ou por mês, em série contínua
- `GET /reports/carts` — o que está parado em carrinho **agora**
- `GET /reports/unsold-products` — peças ACTIVE, com estoque, sem venda no
  período
- Um módulo `reports` novo, **só de leitura**, com as quatro rotas gated em
  `reports.read`
- `REPORTS_TIMEZONE` — o fuso em que semana e mês são cortados

### Não entra (fica pra depois)

- **Qualquer escrita.** Nenhuma rota daqui altera pedido, estoque ou catálogo.
  O módulo não tem `INSERT`, `UPDATE` nem `DELETE` — nem no código, nem no
  vocabulário.
- **Quebra por tamanho.** "Quantas unidades de cada peça" é por **peça**; qual
  tamanho repor é outra pergunta, e o painel não a fez. Ver _Decisões adiadas_.
- **Exportação (CSV/XLSX).** É formatação, e o painel já tem os números.
- **Ticket médio, taxa de conversão, funil, coorte.** Ou são derivados do que
  estas quatro rotas devolvem, ou pedem dado que esta API não guarda (visita,
  sessão).
- **Cache.** As quatro consultas são agregações sobre um catálogo de doze peças
  e um volume de pedidos de loja pequena. Cachear antes de medir é inventar
  invalidação de graça.
- **Auditoria de quem leu relatório.** É o item 6 do mesmo documento e continua
  valendo por si.

## Regras de negócio / invariantes

### 1. Venda é `PAID`, `SHIPPED` ou `DELIVERED`. Uma definição, um lugar.

`CREATED` **não** conta. Um pedido criado é um carrinho congelado com uma
sessão de pagamento aberta: o estoque já saiu, mas o dinheiro não entrou, e
metade deles nunca entra. Contar `CREATED` como receita faria o painel mostrar
faturamento que o extrato bancário não tem — que é a forma mais cara de errar
um relatório.

`CANCELLED` e `REFUNDED` também não. Um cancelado nunca foi pago; um
reembolsado foi pago e voltou. E os dois **devolvem o estoque** (`cancel` e
`markRefunded` chamam `StockService.restock`), então não contá-los como venda é
o que mantém "unidades vendidas" e "estoque que saiu da prateleira" falando a
mesma coisa.

Sobra `PAID | SHIPPED | DELIVERED` — dinheiro que entrou e não voltou. A
constante é **uma só** (`SOLD_STATUSES`) e as quatro rotas a usam, incluindo
`unsold-products`: "sem venda no período" tem que significar exatamente o
complemento de "vendeu no período", ou as duas telas se contradizem.

`REFUNDED` ser um status próprio e não `CANCELLED` é o que torna esta regra
escrevível numa linha — o comentário do modelo já registra o porquê.

### 2. O relógio da receita é `paidAt`, nunca `createdAt`.

Receita acontece quando o dinheiro entra. Um pedido criado dia 31 e pago dia 1º
é receita do mês novo, e é assim que o extrato o vê.

`paidAt` é carimbado na transição `CREATED → PAID`, e `SHIPPED`/`DELIVERED`
passaram por `PAID` obrigatoriamente — então todo pedido que esta spec conta
tem `paidAt` preenchido, por construção da máquina de estados. Não há
`COALESCE` para `createdAt` em lugar nenhum: se um dia existir um pedido `PAID`
sem `paidAt`, ele deve sumir do relatório e ser investigado, não ser remendado
com uma data que significa outra coisa.

`product-sales` e `unsold-products` usam o **mesmo** relógio, pelo mesmo
motivo.

### 3. A janela é `[from, to)` — início inclusivo, fim exclusivo.

É o que faz agosto e setembro não contarem o mesmo pedido duas vezes quando o
painel pede os dois. Ambos são instantes ISO-8601; ambos são opcionais:

- `to` omitido = agora;
- `from` omitido = 30 dias antes de `to`.

`from >= to` é **400**, não lista vazia — mesma postura de
`minPriceCents > maxPriceCents` em `GET /products`: uma janela impossível é bug
de quem chamou, e devolver `[]` esconde isso atrás de algo que parece "nada
encontrado".

### 4. Semana e mês são cortados em `REPORTS_TIMEZONE`, e a coluna é ingênua.

Duas metades, e as duas mordem.

**A primeira:** cortar em UTC uma loja brasileira coloca a venda de domingo às
21h na segunda-feira seguinte — três horas de vendas de todo domingo caem na
semana errada, todo domingo. `REPORTS_TIMEZONE` (default `UTC`) diz em que fuso
o corte acontece; a AVESSO roda `America/Sao_Paulo`. Isso **não** é
generalidade antecipada: é a configuração por implantação que o modelo de reuso
já prevê — a diferença entre lojas mora em configuração, e fuso é o exemplo
canônico.

O valor é validado com `Intl.DateTimeFormat` na construção do serviço: um fuso
inválido derruba o boot com o nome dele, em vez de virar um 500 em toda chamada
de relatório depois. Ele nunca é concatenado em SQL — vai como parâmetro
ligado.

**A segunda, que não é óbvia:** `paid_at` é `TIMESTAMP(3)` **sem** fuso — é o
que o Prisma emite — guardando a leitura de relógio **em UTC**. Então a
expressão certa é

```sql
date_trunc($granularity, (o.paid_at AT TIME ZONE 'UTC') AT TIME ZONE $tz)
```

e não `o.paid_at AT TIME ZONE $tz`. A forma curta está **errada na direção
oposta**: aplicada a um `timestamp` ingênuo, `AT TIME ZONE` não converte _de_
UTC _para_ São Paulo — ela declara que aquele relógio já era de São Paulo e
converte para `timestamptz`. O erro é de três horas, silencioso, e some em
qualquer teste feito perto do meio-dia. O primeiro `AT TIME ZONE 'UTC'` é o que
ancora a coluna ingênua num instante; o segundo é o que a leva ao fuso da loja.

Pela mesma razão, `from` e `to` são comparados como texto ISO **sem sufixo de
fuso**, casteado para `::timestamp`: passar um `Date` deixaria o driver
serializá-lo com o deslocamento do processo, e um `::timestamp` sobre isso
descarta o deslocamento silenciosamente — o mesmo erro, agora nas bordas da
janela.

### 5. `periodStart` é uma data de calendário, não um instante.

Sai como `"2026-08-24"`, texto, formatado no banco. Devolver um instante
convidaria o navegador a reinterpretá-lo no fuso _dele_ e a desenhar a barra na
semana anterior — que é o bug da regra 4 reintroduzido do lado do cliente,
depois de todo esse trabalho para não tê-lo do lado do servidor.

A semana começa na **segunda-feira** (`date_trunc('week', …)` do Postgres é
ISO).

### 6. A série de receita não tem buracos.

Uma semana sem venda volta como um bucket de zeros, não como ausência. Um
gráfico de barras que pula a semana ruim desenha a loja como se ela não
existisse, e o cliente teria que reconstruir o calendário para descobrir isso.
Os buckets vêm de um `generate_series` sobre a janela, com `LEFT JOIN` no que
vendeu.

### 7. Dinheiro é `Int` em centavos, somado no banco.

`SUM` de `int` no Postgres é `bigint`, que chega ao Node como `BigInt` ou como
string dependendo do caminho. Toda soma volta explicitamente `::bigint` e passa
por um conversor único (`toCount`) que a transforma em `number` — exato até
2^53 centavos, ou noventa trilhões de reais. Nenhum `reduce` de JavaScript soma
dinheiro nesta spec: o banco soma, o Node transporta.

`revenueCents === itemsSubtotalCents + shippingCents` em todo bucket, porque
vale por pedido — a migration tem o `CHECK`.

### 8. O nome da peça vem do catálogo vivo; o agrupamento, do `productId`.

`OrderItem` carrega `productName` como snapshot — de propósito, para que
renomear não reescreva o que alguém comprou. Mas um relatório agrupado pelo
snapshot **parte a peça em duas linhas** no dia em que ela é renomeada no meio
do período, e o painel lista produtos pelo nome que eles têm hoje.

Então: `GROUP BY product_id`, e `name`/`slug` vêm de um `JOIN products`. O
`JOIN` é seguro por construção — `OrderItem.product` é `onDelete: Restrict` e o
catálogo arquiva em vez de apagar, então a linha sempre está lá.

### 9. Carrinho conta **unidades**, e o 409 da variante conta **linhas**.

Os dois números existem e são diferentes.
`VariantInCartsResponse.cartLineCount` é `COUNT(*)` de `cart_items` para **uma**
variante — quantas sacolas seriam esvaziadas se aquele tamanho sumisse.
`GET /reports/carts` responde `SUM(quantity)` sobre **todo** `cart_items`: três
unidades da mesma peça numa sacola são 3, não 1 (é a mesma escolha que
`CartResponse.itemCount` já fez).

Junto vêm `lineCount` e `cartCount`, da mesma consulta, porque um número solto
não se lê: 40 unidades em 2 carrinhos e 40 unidades em 30 carrinhos são
situações opostas. **`cartCount` só conta carrinho com ao menos uma linha** — o
checkout consome os itens e deixa a linha de `carts` viva e vazia, então contar
carrinhos seria contar todo mundo que já comprou uma vez.

### 10. Estas rotas respondem **403**, e isso não contradiz o padrão da casa.

O padrão de 404-em-vez-de-403 protege a **existência de um recurso**: produto
`DRAFT`, pedido de outra pessoa. Ele existe porque um 403 confirmaria a quem
sonda um id que há algo ali.

Nenhuma das quatro rotas aqui recebe id de recurso — não há path param, e nenhum
filtro por id. Não há existência a vazar: o que um 403 revela é que a rota
`/reports/*` existe, e isso o documento OpenAPI publicado já diz. Então elas são
gated por `@RequirePermissions(reports.read)` como toda rota de back-office
deste repositório, e respondem 403 como `POST /orders/{id}/refund` responde.
Inventar um 404 aqui seria copiar a forma de um padrão sem a razão dele.

### 11. `reports` lê tabelas que não são dele, e é a única exceção.

O mapa de módulos diz que `orders` nunca toca nas tabelas do `catalog` — passa
por `ProductsService` e `StockService`. `reports` **não** segue essa regra, e a
escolha é deliberada.

A alternativa seria pendurar quatro métodos com cara de relatório em
`OrdersService` e `ProductsService` — cada um com um `date_trunc` ou um
`GROUP BY` que só o painel entende, num serviço que não tem outro motivo para
conhecer bucket de semana. A outra alternativa, montar os números em memória a
partir dos serviços existentes, é justamente o que esta spec proíbe: soma de
dinheiro é do banco.

O que torna a exceção segura é o que o módulo **não** pode fazer: só `SELECT`,
só agregado, nenhuma rota de escrita, e nenhum outro módulo depende dele
(`reports` é folha e não exporta nada). Uma folha somente-leitura não cria ciclo
nem acoplamento de domínio — cria uma leitura que precisa ser mantida junto com
o schema, e é esse o custo aceito aqui, registrado para que ninguém o descubra
por acidente.

## Superfície da API

Quatro rotas novas, todas `GET`, todas gated na mesma permissão.

| Método | Rota                        | Descrição                                 | Auth           |
| ------ | --------------------------- | ----------------------------------------- | -------------- |
| GET    | `/reports/product-sales`    | unidades e receita por peça, num período  | `reports.read` |
| GET    | `/reports/revenue`          | receita por semana ou por mês             | `reports.read` |
| GET    | `/reports/carts`            | unidades paradas em carrinho agora        | `reports.read` |
| GET    | `/reports/unsold-products`  | ACTIVE, com estoque, sem venda no período | `reports.read` |

`reports.read` hoje pertence a **`operator`** (explicitamente) e a **`admin`**
(que recebe `Object.values(PERMISSIONS)`). Conferido em
`src/auth/authz/role-permissions.ts`, não presumido — e é o que a descrição do
documento OpenAPI já anuncia.

`product-sales` e `unsold-products` paginam com o mesmo envelope de todo o resto
(`items`/`total`/`page`/`perPage`, `perPage` clampado em 100). `revenue` **não**
pagina: um gráfico precisa da série inteira, e a janela já a limita.

### DTOs (esboço)

```ts
/** A janela, compartilhada pelas três rotas que têm período. */
export class ReportPeriodQueryDto {
  /** ISO-8601. Omitido = 30 dias antes de `to`. Inclusivo. */
  from?: string;
  /** ISO-8601. Omitido = agora. EXCLUSIVO. */
  to?: string;
}

export class ProductSalesRowResponse {
  productId: string;
  /** Do catálogo vivo, não do snapshot do item — ver invariante 8. */
  name: string;
  slug: string;
  unitsSold: number;
  /** Só os itens. O frete está em /reports/revenue, não aqui. */
  itemsRevenueCents: number;
  orderCount: number;
}

export class RevenueBucketResponse {
  /** Data de calendário no fuso da loja, "YYYY-MM-DD". Nunca um instante. */
  periodStart: string;
  /** itemsSubtotalCents + shippingCents. O que foi cobrado. */
  revenueCents: number;
  itemsSubtotalCents: number;
  shippingCents: number;
  orderCount: number;
}

export class RevenueReportResponse {
  from: Date;
  to: Date;
  granularity: 'week' | 'month';
  /** O fuso em que os buckets foram cortados — REPORTS_TIMEZONE. */
  timeZone: string;
  buckets: RevenueBucketResponse[];
}

export class CartsReportResponse {
  /** SUM(quantity) — peças, não linhas. */
  unitCount: number;
  lineCount: number;
  /** Carrinhos com ao menos uma linha. */
  cartCount: number;
}

export class UnsoldProductRowResponse {
  productId: string;
  name: string;
  slug: string;
  /** Soma entre as variantes. Sempre > 0 aqui. */
  stockQuantity: number;
  /** Última venda de qualquer época, ou null se nunca vendeu. */
  lastSoldAt: Date | null;
}
```

Ordenações, todas com desempate por `productId` para a página ser estável
(mesma razão dos sorts do catálogo):

- `product-sales`: `unitsSold` desc — página 1 é o que mais saiu;
- `unsold-products`: `stockQuantity` desc — a peça com mais capital parado
  primeiro, que é a que decide uma promoção.

## Critérios de aceitação

**Permissão e forma**

- [ ] Dado um chamador sem `reports.read`, quando chama qualquer uma das quatro
      rotas, então **403** — e a descrição do 403 no documento nomeia
      `reports.read`
- [ ] Dado nenhum token, quando chama qualquer uma das quatro, então 401
- [ ] Dado um `operator`, quando chama as quatro, então 200 nas quatro
- [ ] Dado `from` posterior ou igual a `to`, então 400
- [ ] Dado `from` que não é data ISO, então 400

**O que conta como venda**

- [ ] Dado um pedido `CREATED` no período, quando o painel lê `revenue`, então
      ele **não** entra na receita
- [ ] Dado um pedido `CANCELLED` e um `REFUNDED` no período, então nenhum dos
      dois entra na receita nem em `unitsSold`
- [ ] Dado um pedido `PAID`, um `SHIPPED` e um `DELIVERED`, então os três entram
- [ ] Dado um pedido pago **fora** da janela, então ele não entra

**Unidades por peça**

- [ ] Dados dois tamanhos da mesma peça vendidos no mesmo pedido, então
      `product-sales` traz **uma** linha, com a soma das unidades
- [ ] Dada uma peça renomeada depois da venda, então ela continua sendo uma
      linha só, com o nome **atual**
- [ ] Dado um período sem venda nenhuma, então `items` é `[]` e `total` é 0

**Receita por semana e por mês**

- [ ] Dado `granularity=month`, então cada bucket traz `periodStart` no primeiro
      dia do mês e `revenueCents` igual à soma de `totalCents` dos pedidos
      vendidos nele
- [ ] Dado um bucket qualquer, então
      `revenueCents === itemsSubtotalCents + shippingCents`
- [ ] Dada uma semana sem venda no meio da janela, então ela aparece como bucket
      de zeros, e não some
- [ ] Dado `granularity=week`, então `periodStart` cai numa segunda-feira
- [ ] Dado `REPORTS_TIMEZONE=America/Sao_Paulo` e uma venda às 23:30 UTC do dia
      1º (20:30 local), então ela cai no bucket do dia **1º**, não do dia 2

**Carrinhos**

- [ ] Dadas três unidades de uma peça e uma de outra, num carrinho só, então
      `unitCount` é 4, `lineCount` é 2 e `cartCount` é 1
- [ ] Dado um carrinho que foi ao checkout (linha de `carts` viva e vazia),
      então ele não entra em `cartCount`
- [ ] Dado nenhum carrinho com item, então os três números são 0

**Peças paradas**

- [ ] Dada uma peça ACTIVE, com estoque, sem venda no período, então ela aparece
- [ ] Dada uma peça que vendeu no período, então ela **não** aparece
- [ ] Dada uma peça ACTIVE sem estoque nenhum, então ela não aparece — não é
      "parada", é esgotada
- [ ] Dada uma peça `DRAFT` ou `ARCHIVED`, então ela não aparece
- [ ] Dada uma peça que nunca vendeu, então `lastSoldAt` é `null`
- [ ] Dada uma peça que vendeu antes da janela, então ela aparece e `lastSoldAt`
      traz a data daquela venda

**Nada muda**

- [ ] Dada qualquer chamada às quatro rotas, então pedido, estoque e catálogo
      seguem idênticos

## Edge cases conhecidos

- **Pedido pago e depois reembolsado dentro da mesma janela.** Some dos dois
  relatórios, como se não tivesse acontecido. É o certo para "receita" e é
  incompleto para "quanto reembolsamos" — que é uma quinta pergunta, e o painel
  não a fez. Registrada em _Decisões adiadas_.
- **Peça vendida e depois arquivada.** Continua em `product-sales` (o `JOIN`
  acha a linha; o catálogo nunca apaga) e some de `unsold-products`, que filtra
  `ACTIVE`. As duas leituras estão certas: ela vendeu, e não faz sentido pedir
  para promover uma peça que saiu de catálogo.
- **`REPORTS_TIMEZONE` mudado depois de a loja rodar um tempo.** Os relatórios
  passados mudam de forma, porque o corte é calculado na leitura e não
  materializado. É o comportamento certo — o alternativo seria dois períodos com
  regras diferentes no mesmo gráfico — mas quem muda precisa saber.
- **Horário de verão.** `America/Sao_Paulo` não tem desde 2019. Se um dia uma
  loja rodar num fuso que tem, uma semana do ano terá 167 ou 169 horas; o
  `date_trunc` do Postgres lida com isso corretamente e o total do ano continua
  fechando.
- **Janela gigante.** `from` em 2020 com `granularity=week` são ~350 buckets num
  único corpo. Não é problema hoje (o `generate_series` é barato e o corpo é
  pequeno), e não há cap. Se virar, o cap é uma linha e um 400.
- **`itemsRevenueCents` não bate com `revenueCents` de `revenue`.** Por
  construção: o primeiro é só item, o segundo inclui frete. Os nomes são
  diferentes exatamente para que ninguém os some.
- **Concorrência.** As quatro consultas leem sem lock, em `READ COMMITTED`. Um
  pedido pago no meio da leitura pode entrar num número e não no outro. Aceito
  sem hesitação: é um relatório, não um extrato conciliado.

## Decisões adiadas

- **Quebra por tamanho em `product-sales`.** "Qual tamanho repor" é a pergunta
  mais útil que este módulo _não_ responde, e `OrderItem.variantId` já tem o
  dado. Fica de fora porque o painel pediu por peça, e um `variants[]` dentro de
  cada linha dobra a consulta para uma tela que ninguém desenhou. Entra no dia
  em que alguém desenhar.
- **Valor parado em carrinho.** `GET /reports/carts` conta unidades e não
  centavos. Carrinho não guarda preço — o valor sairia de um `JOIN` com
  `products` a preço vivo, o que é factível e é uma quinta pergunta.
- **Reembolsos como relatório próprio.** Quanto voltou, por período. O dado está
  todo lá (`refundedAt`, `totalCents`, `refundRef`); falta alguém precisar.
- **Comparação com o período anterior** ("+12% vs. mês passado"). O painel
  consegue com duas chamadas. Só vale virar rota se as duas chamadas virarem
  hábito.
- **Materializar os buckets.** Uma tabela de resumo por dia, escrita na
  transição para `PAID`. É a resposta certa para volume que estas consultas não
  aguentem — e medir vem antes.
