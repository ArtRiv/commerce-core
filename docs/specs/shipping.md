# Spec: shipping (frete)

## Status

`implementado`

Entregue de uma vez: migration (colunas de dinheiro, snapshot do método,
rastreio, peso no produto e os `CHECK`s), o módulo `shipping` com o
`TableShippingProvider` atrás do token, a cotação e o recálculo dentro do
`orders`, o contrato do catálogo crescendo pra carregar peso, unitários em
cada unidade e `test/shipping.e2e-spec.ts` por cima de tudo.

Duas coisas mudaram durante a implementação, e as duas vieram de escrever
o teste:

1. A mensagem do `409` de "nenhuma opção" **não** fala em CEP. A lista
   vazia tem duas causas — CEP sem cobertura e parcela pesada demais — e o
   provedor não as distingue, então "não entregamos nesse CEP" seria
   mentira metade das vezes. Virou "nenhuma opção de entrega disponível
   para este carrinho e endereço".
2. A tabela default cobre os dez dígitos de CEP, ou seja, o país inteiro.
   Isso é proposital (clone novo vende pra qualquer lugar), mas significa
   que o caminho "não entregamos aí" só é alcançável por **peso** no e2e —
   e é assim que ele é testado.

Verificado: migration aplicada (as oito colunas e os quatro `CHECK`
existem no banco), 334 unitários, e a suíte e2e inteira verde — 144 testes,
sete arquivos, incluindo os 19 deste módulo e as suítes que este PR mexeu
por tabela (`orders`, `payments`) ou por DTO (`catalog`).

Um detalhe de teste que a primeira execução expôs: o e2e do rate limit
gasta o orçamento com requisições que o `ValidationPipe` recusa. Guard roda
antes de pipe, então elas contam pro limite sem custar leitura de carrinho
e catálogo — e o `429` acaba caindo sobre uma cotação **válida**, que é a
afirmação mais forte. Ainda assim são 31 idas ao banco hospedado (o
`JwtStrategy` resolve permissões a cada requisição), então esse teste
declara timeout próprio de 120s.

Último módulo de domínio do escopo da v1, e o que fecha a última seta-alvo
da [`architecture/modules.md`](../architecture/modules.md). O problema que
ele resolve: o pedido guardava o **endereço** de entrega e nenhuma coluna
de frete, então `totalCents` era só a soma dos itens — e como `payments`
cobra exatamente `totalCents` no Stripe, a loja entregava de graça.

Decisões estruturais alinhadas antes desta spec:

1. **`totalCents` passa a ser o total cobrado** (itens + frete), com o
   subtotal e o frete em colunas próprias e a soma garantida por `CHECK`.
2. **Cotação e checkout**: o cliente escolhe um **código** de opção e
   **afirma** o preço que viu; o servidor recalcula e cobra o dele.
3. **`TableShippingProvider`** (tabela por faixa de CEP, configurada por
   ambiente) como primeiro provedor, atrás de `SHIPPING_PROVIDER` —
   transportadora real depois, atrás da mesma interface.
4. **`Product` ganha `weightGrams`**, pra que a cotação carregue peso de
   verdade e um adapter de transportadora seja escrevível.
5. **O ciclo de vida do pedido não muda**; rastreio é dado, não estado.

### Buracos de cobertura conhecidos

- **Não existe adapter de transportadora**, então a adequação da interface
  a uma é **argumento, não teste** — o mesmo tipo de buraco honesto que
  `payments` registra pro `refunds.create`. O desenho aposta em três
  coisas que só um adapter real confirma: que `quote` assíncrono devolvendo
  N opções é a forma certa, que peso sem dimensões basta, e que "lista
  vazia" e "lançou" cobrem os desfechos que importam.
- **Sem dimensões, sem cubagem.** Item volumoso e leve (travesseiro,
  luminária) vai ser cotado barato demais, e a loja paga a diferença. Só
  aparece com transportadora de verdade, porque a tabela não tem esse
  conceito.
- **O peso default mascara produto não pesado.** Todo produto existente
  nasce com `weightGrams` nulo e é cotado como 500 g. Não bloqueia venda de
  propósito; a saída é preencher o peso.
- Diferente de `catalog`, `orders` e `payments`, este módulo **não tem
  critério de RLS** — ele não cria tabela nenhuma.

## Objetivo

Fazer o frete existir no dinheiro do pedido: cotar entrega a partir do CEP
e do carrinho, congelar o valor escolhido no checkout e somá-lo ao total
que o cliente paga. O provedor de verdade fica atrás de uma interface
própria (`ShippingProvider`), mesmo padrão de `payments` e `mail`, pra que
trocar tabela fixa por transportadora não toque em `orders`.

## Escopo

### Entra

- `ShippingProvider` atrás do token `SHIPPING_PROVIDER`, com um único
  método `quote` — assíncrono, devolvendo N opções, podendo recusar o
  destino (lista vazia) ou falhar (transportadora fora do ar)
- `TableShippingProvider`: tabela de opções por prefixo de CEP, com faixas
  de peso, prazo estimado e frete grátis acima de um valor, configurada
  por ambiente e validada no boot
- `POST /shipping/quote` — opções de frete pro carrinho do próprio caller
- Checkout passa a exigir `shippingOptionCode` + `quotedShippingCents`,
  **recalcula** o frete no servidor e cobra o valor recalculado
- Colunas novas no pedido: `itemsSubtotalCents`, `shippingCents` (com
  `totalCents` redefinido como a soma dos dois, garantida por `CHECK`) e o
  snapshot do método escolhido (`shippingMethodCode`, `shippingMethodName`,
  `shippingEtaDays`)
- `weightGrams` no produto (opcional), com peso default configurável pra
  quem não preencheu, e o contrato do catálogo (`findByIds`) crescendo
  junto
- `POST /orders/:id/ship` aceita `{ trackingCode?, trackingUrl? }`
- Migration com backfill aritmeticamente neutro nos pedidos existentes

### Não entra (fica pra depois)

- **Transportadora real** (Correios via CWS, Melhor Envio): as duas exigem
  contrato/credencial que ainda não existem, e travar o último módulo da
  v1 — logo, o deploy, que o `claude/context.md` chama de critério de
  sucesso — num cadastro é exatamente como a tentativa anterior morreu. A
  interface é desenhada pro caso da transportadora mesmo assim
- **Compra de etiqueta / despacho** (`dispatch`, PDF, assinatura de
  rastreio): outra integração inteira. `ShippingProvider` fica com um
  método só, e o segundo entra quando um adapter real precisar dele
- **Dimensões e cubagem** (empacotamento em caixas): v1 cota por peso.
  Cubagem só morde item volumoso e leve, e resolver bem exige um
  algoritmo de _bin packing_ que não cabe aqui
- **Tabela de frete no banco + CRUD de back-office**: seria tabela nova,
  RLS, rotas e permissões — feature própria. v1 configura por ambiente e
  aceita que mudar frete é redeploy
- **Cotação anônima** (sem login, por lista explícita de itens) — o
  carrinho da v1 já exige autenticação
- **Retirada na loja**, múltiplas origens, envio fracionado (um pedido
  saindo em duas remessas)
- **Cupom de frete grátis** — cupons já são feature adiada inteira
- **Consulta de CEP** (ViaCEP e afins) pra preencher endereço: é
  conveniência de frontend, não de API
- **Reembolso parcial** que devolva os itens sem o frete — reembolso
  parcial não existe na v1 (ver [`payments.md`](payments.md))

## Regras de negócio / invariantes

- **`totalCents` é o que o cliente paga**, e passa a valer
  `itemsSubtotalCents + shippingCents`. A regra não é convenção: é um
  `CHECK` no banco, então nenhum caminho de código consegue gravar as três
  colunas em desacordo.

  A escolha é sobre modo de falha, não sobre estética. `payments` cobra
  `order.totalCents` numa linha agregada (`stripe-payment.provider.ts`),
  então **redefinir a coluna deixa o caminho do dinheiro correto sem tocar
  em `payments`**. Se o frete morasse numa coluna irmã, toda leitura de
  dinheiro daqui pra frente — sessão de pagamento, e-mail de confirmação,
  relatório, reembolso parcial — teria que lembrar de somar, e **esquecer
  significaria cobrar a menos**. Aqui esquecer não produz bug.
- **O pedido continua registro imutável.** A migration só **adiciona**
  colunas e faz um backfill aritmeticamente idêntico ao que já foi cobrado
  (`items_subtotal_cents = total_cents`, `shipping_cents = 0`). Nenhum
  pedido existente muda de valor; `totalCents` continua sendo exatamente o
  número que passou no cartão.
- **O cliente escolhe o código, nunca o preço.** `shippingOptionCode` é a
  escolha; `quotedShippingCents` é **asserção**, comparada e descartada. O
  valor gravado e cobrado é sempre o recalculado no servidor a partir do
  carrinho e do CEP do próprio checkout. Aceitar um preço vindo do cliente
  seria aceitar `shippingCents: 0`.
- **Divergência é `409`, não cobrança silenciosa.** Se o recálculo não
  bate com o valor afirmado, o checkout falha devolvendo as opções atuais
  — nada de decremento de estoque, nada de pedido. Recalcular e cobrar
  calado nunca cobraria a menos, mas cobraria do cliente um preço que ele
  não viu; além de má UX, o art. 30 do CDC prende o fornecedor à oferta
  anunciada.
- **Checkout NÃO tolera falha do provedor de frete** → `503`, nada
  decrementado, nenhum pedido. Isso é o **oposto** do que o checkout faz
  com `payments`, e a assimetria é deliberada: um pedido sem sessão de
  pagamento é recuperável (`POST /orders/:id/pay` existe pra isso), mas um
  pedido sem frete é um pedido com o **total errado** — e ele nasce
  imutável e prestes a ser cobrado. Não há rota de conserto pra isso,
  então o único momento seguro de falhar é antes de criar o pedido.
- **Método de entrega é snapshot**, como preço e endereço. `R$ 24,90` sem
  "Entrega padrão, 5 dias úteis" não é auditável nem exibível — o e-mail
  de confirmação e o painel precisam do nome, não só do número.
- **CEP sem opção significa "não entregamos aí".** `quote` devolve lista
  vazia (`200`, não erro — é resposta legítima), e o checkout naquele
  endereço responde `409`. Peso acima do teto da tabela cai no mesmo
  lugar.
- **Frete grátis é preço zero, não ausência de frete.** A opção continua
  existindo, com `priceCents: 0`, e o pedido guarda o método normalmente —
  `shippingCents = 0` com método preenchido é "grátis", e é diferente de
  um pedido antigo do backfill, que tem método nulo.
- **`shippingCents >= 0`, mas `itemsSubtotalCents > 0`** (o `CHECK` de
  `total_cents > 0` que já existe continua valendo). Frete zero é
  legítimo; pedido de valor zero não.
- **Reembolso devolve o frete junto.** `refunds.create` sem `amount` é
  reembolso total do intent, então o frete já voltaria hoje — a regra
  passa a ser escrita em vez de acidente do default do Stripe. E faz
  sentido: só pedido `PAID` é reembolsável na v1, e pedido `PAID` não foi
  despachado.
- **O ciclo de vida não muda.** `CREATED → PAID → SHIPPED → DELIVERED`
  mais `CANCELLED`/`REFUNDED` continua idêntico. Rastreio é **dado**:
  `POST /orders/:id/ship` aceita código e URL opcionais. Opcionais porque
  entrega local (motoboy, retirada combinada) não tem código, e exigir um
  bloquearia um envio legítimo. Nenhuma transição chama transportadora na
  v1.
- **Peso ausente cai no default configurado**, não bloqueia o checkout.
  Todo produto existente tem `weightGrams` nulo no dia da migration;
  recusar venda até alguém preencher derrubaria a loja inteira. O default
  é uma mentira controlada e documentada, e a saída é preencher o peso.
- **`shipping` não conhece `catalog` nem `orders`.** Quem lê o carrinho e
  resolve pesos é `orders`, pelo contrato que já usa
  (`ProductsService.findByIds`, que passa a expor `weightGrams`); o
  provedor recebe um request já montado. É o que mantém a seta
  `orders → shipping` de mão única, com `shipping` como folha do grafo.
- **A rota de cotação mora em `orders`**, mesma decisão (e mesmo motivo)
  do webhook de pagamento: ela lê o **carrinho**. Hospedá-la em `shipping`
  faria `shipping` depender de `orders` (ou de `catalog`), que é ciclo e o
  contrário da regra do grafo. A URL segue chamando `/shipping/quote`,
  porque é o nome que um frontend procura.
- **Uma tabela de frete inválida derruba o boot** fora de
  `development`/`test` — mesma lista de permissão do
  `resolvePaymentProvider`, e pelo mesmo motivo: uma loja que
  silenciosamente cobra o frete errado em todo pedido é pior que uma que
  não sobe. Em dev/test, ausência de configuração cai numa tabela default
  embutida com aviso no boot, pra que um clone novo tenha checkout
  funcionando (mesma cortesia do `FakePaymentProvider`).
- **Ordem das opções é determinística**: preço crescente, empate por
  prazo, empate por código. Lista instável faria o "primeiro da lista" do
  frontend mudar sem motivo.
- **Nenhuma tabela nova neste módulo** — a configuração é ambiente e o
  snapshot é coluna. É a primeira vez que um módulo não traz migration de
  RLS; a regra do projeto continua valendo, só não tem sujeito aqui.
- **Erro segue a convenção:** input malformado (CEP fora de formato,
  `quotedShippingCents` negativo) → `400`; sem token → `401`; requisição
  válida em conflito com o estado (código de opção inexistente, preço
  divergente, CEP sem cobertura, peso acima do teto) → `409`; provedor
  indisponível → `503`, tanto na cotação quanto no checkout.

## Modelo de dados (esboço Prisma)

```prisma
model Order {
  // ... tudo que já existe

  /// Soma de unitPriceCents × quantity dos itens, congelada no checkout.
  /// Era o significado de totalCents antes de o frete existir.
  itemsSubtotalCents Int @map("items_subtotal_cents")

  /// Frete congelado no checkout. Zero é legítimo (frete grátis); o método
  /// abaixo é o que distingue "grátis" de "pedido anterior ao frete".
  shippingCents Int @map("shipping_cents")

  /// O TOTAL COBRADO: itemsSubtotalCents + shippingCents, garantido por
  /// CHECK. É o número que payments manda pro Stripe.
  totalCents Int @map("total_cents")

  /// Snapshot do método escolhido — mesma filosofia de productName e do
  /// endereço. Nulos só nos pedidos anteriores a este módulo.
  shippingMethodCode String? @map("shipping_method_code")
  shippingMethodName String? @map("shipping_method_name")
  shippingEtaDays    Int?    @map("shipping_eta_days")

  /// Preenchidos (opcionalmente) na transição PAID → SHIPPED. Dado, não
  /// estado: nenhuma transição nova nasce disso.
  trackingCode String? @map("tracking_code")
  trackingUrl  String? @map("tracking_url")
}

model Product {
  // ... tudo que já existe

  /// Peso da unidade, em gramas. Opcional porque todo produto existente
  /// nasce sem ele; a cotação usa SHIPPING_DEFAULT_WEIGHT_GRAMS quando
  /// falta. Sem dimensões na v1 — cubagem é decisão adiada.
  weightGrams Int? @map("weight_grams")
}
```

`CHECK`s da migration (o Prisma não os modela, então vivem só no SQL, como
os de `orders`/`order_items`):

```sql
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_cents_not_negative"
  CHECK ("shipping_cents" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_items_subtotal_cents_positive"
  CHECK ("items_subtotal_cents" > 0);
-- A invariante do módulo inteiro, em uma linha que nenhum refactor apaga.
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_is_items_plus_shipping"
  CHECK ("total_cents" = "items_subtotal_cents" + "shipping_cents");
ALTER TABLE "products" ADD CONSTRAINT "products_weight_grams_positive"
  CHECK ("weight_grams" IS NULL OR "weight_grams" > 0);
```

Ordem obrigatória da migration, pra que ela passe com pedidos já no banco:
adicionar `shipping_cents NOT NULL DEFAULT 0` e `items_subtotal_cents`
nulável → `UPDATE orders SET items_subtotal_cents = total_cents` →
`SET NOT NULL` → **`DROP DEFAULT` no `shipping_cents`** (pra que todo
pedido novo escreva o valor explicitamente, sem zero por acidente) →
adicionar os `CHECK`s.

## Superfície da API

| Método | Rota               | Descrição                                          | Auth                   |
| ------ | ------------------ | -------------------------------------------------- | ---------------------- |
| POST   | `/shipping/quote`  | Opções de frete pro carrinho do caller, por CEP    | autenticado            |
| POST   | `/orders`          | Checkout — agora exige escolha e asserção de frete | autenticado            |
| POST   | `/orders/:id/ship` | `PAID → SHIPPED`, agora aceita rastreio            | `orders.update_status` |

Nenhuma rota nova além da cotação, e nenhuma permissão nova: cotar é ação
de cliente sobre o próprio carrinho, e rastreio entra numa rota que já
existe e já é do back-office.

`/shipping/quote` tem rate limit próprio (`SHIPPING_QUOTE`, 30/min): hoje
é cálculo local e barato, mas a transportadora atrás da mesma interface
transforma cada chamada numa ida à rede e num limite de terceiro — mesmo
raciocínio de `ISSUE_PAYMENT`.

### DTOs (esboço)

```ts
class ShippingQuoteDto {
  /** 8 dígitos, com ou sem hífen; normalizado antes de cotar. */
  postalCode: string;
}

class CheckoutDto {
  shippingAddress: ShippingAddressDto;
  paymentMode?: CheckoutMode;

  /** Código devolvido por /shipping/quote. Obrigatório. */
  shippingOptionCode: string;

  /**
   * O que o cliente VIU. Asserção: comparada com o recálculo e descartada,
   * nunca gravada. Int >= 0.
   */
  quotedShippingCents: number;
}

class ShipOrderDto {
  trackingCode?: string;
  trackingUrl?: string; // URL válida quando presente
}
```

Resposta de `/shipping/quote`: `{ options: ShippingOption[] }` — objeto e
não array pra poder crescer (ex: `unavailableReason`) sem quebrar cliente.

Resposta do checkout e de `GET /orders/:id`: o pedido de sempre, agora com
`itemsSubtotalCents`, `shippingCents`, `totalCents` e o método congelado.

### Contrato com shipping (v1)

```ts
export interface ShippingQuoteItem {
  productId: string;
  quantity: number;
  /** Valor declarado / regra de frete grátis. */
  unitPriceCents: number;
  /** Já resolvido: o default do ambiente foi aplicado antes daqui. */
  weightGrams: number;
}

export interface ShippingQuoteRequest {
  /**
   * Só o CEP: no Brasil ele determina cidade e UF, e é o que Correios e
   * Melhor Envio recebem. Cidade/UF continuam no snapshot do pedido, mas
   * não participam da cotação.
   */
  destination: { postalCode: string };
  items: ShippingQuoteItem[];
  subtotalCents: number;
}

export interface ShippingOption {
  /** Estável: 'padrao-sudeste' hoje, 'correios.pac' depois. */
  code: string;
  label: string;
  /** >= 0. Zero é frete grátis, não ausência de opção. */
  priceCents: number;
  estimatedDays: number | null;
  carrier: string | null;
}

export interface ShippingProvider {
  /**
   * Lista vazia = não entregamos nesse destino (resposta legítima).
   * Lançar = a transportadora está fora do ar (503 pra quem chamou).
   */
  quote(request: ShippingQuoteRequest): Promise<ShippingOption[]>;
}

export const SHIPPING_PROVIDER = Symbol('SHIPPING_PROVIDER');
```

Um método só, de propósito: comprar etiqueta é outra integração
(pagamento, PDF, assinatura de rastreio), e um `dispatch()` que ninguém
chama é pior que uma interface que cresce quando um adapter real precisar.
O que prova o desenho é que um adapter de Correios cabe atrás de `quote`
sem mudar a assinatura.

Diferença consciente em relação a `payments`: **não existe "fake"** e não
existe guarda de produção por provedor. `TableShippingProvider` é o
provedor de verdade da v1 — determinístico, sem rede, seguro em produção.
O que derruba o boot aqui é **configuração inválida**, não ausência de
provedor.

### Configuração necessária

| Variável                        | Para quê                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SHIPPING_TABLE`                | JSON com as opções por faixa de CEP. Ausente em dev/test → tabela default embutida com aviso; fora disso, boot falha. |
| `SHIPPING_FREE_ABOVE_CENTS`     | Opcional. Subtotal a partir do qual toda opção sai por `0`. Ausente/vazio = sem frete grátis.                         |
| `SHIPPING_DEFAULT_WEIGHT_GRAMS` | Opcional, default `500`. Peso assumido pra produto com `weightGrams` nulo.                                            |

Formato de `SHIPPING_TABLE` — uma lista plana de **opções**, cada uma com
seus prefixos de CEP, prazo e faixas de peso. Plana em vez de aninhada por
zona porque assim a mesma região pode ter "padrão" e "expressa" sem
nenhuma estrutura a mais:

```json
[
  {
    "code": "padrao-sudeste",
    "label": "Entrega padrão",
    "prefixes": ["0", "1", "2", "3"],
    "etaDays": 5,
    "rates": [
      { "upToGrams": 1000, "priceCents": 1990 },
      { "upToGrams": 30000, "priceCents": 3990 }
    ]
  },
  {
    "code": "padrao-brasil",
    "label": "Entrega padrão",
    "prefixes": ["4", "5", "6", "7", "8", "9"],
    "etaDays": 10,
    "rates": [{ "upToGrams": 30000, "priceCents": 4990 }]
  }
]
```

O primeiro dígito do CEP já separa o país em regiões (0-1 SP, 2 RJ/ES,
3 MG, 4 BA/SE, 5 PE/AL/PB/RN, 6 CE/PI/MA/PA/AM/AC/AP/RR, 7 DF/GO/TO/MT/
MS/RO, 8 PR/SC, 9 RS), então uma tabela útil não precisa de dado externo
nenhum. Prefixos mais longos (`"013"`) recortam faixas menores.

Regras de resolução, todas verificadas no boot:

- toda opção cujo prefixo casa o CEP **e** cuja última faixa cobre o peso
  total entra na resposta — não existe "vence o mais específico", quem
  casa aparece
- o preço é o da primeira faixa com `upToGrams >= pesoTotal`; peso acima
  da última faixa elimina a opção
- `code` único, `prefixes` só com dígitos e no máximo 8, `rates` não-vazio
  e com `upToGrams` estritamente crescente, `priceCents >= 0` — qualquer
  violação é erro de boot com a mensagem apontando a opção

## Critérios de aceitação

Todos cobertos por teste verde — unitário, e2e, ou os dois.

Cotação:

- [x] Dado um carrinho com itens e um CEP coberto, quando cotoo, então
      recebo as opções que casam com o CEP e o peso, ordenadas por preço,
      cada uma com `code`, `label`, `priceCents` e `estimatedDays`.
- [x] Dado um CEP que nenhuma opção cobre, quando cotoo, então recebo
      lista vazia — não um erro.
- [x] Dado um carrinho cujo peso total passa do teto de toda opção da
      região, quando cotoo, então recebo lista vazia.
- [x] Dado `SHIPPING_FREE_ABOVE_CENTS` configurado e um carrinho acima do
      valor, quando cotoo, então toda opção volta com `priceCents: 0` e o
      `label`/prazo intactos.
- [x] Dado um produto sem `weightGrams`, quando cotoo, então o peso
      default do ambiente é usado e a cotação acontece normalmente.
- [x] Dado um carrinho vazio, quando cotoo, então recebo `409`.
- [x] Dado um CEP malformado, quando cotoo, então recebo `400`; sem
      token → `401`.
- [x] Dado o provedor lançando, quando cotoo, então recebo `503`.

Checkout:

- [x] Dado um carrinho válido e uma opção cotada, quando faço checkout com
      `shippingOptionCode` e `quotedShippingCents` corretos, então o pedido
      nasce com `itemsSubtotalCents` = soma dos itens, `shippingCents` =
      valor da opção, `totalCents` = a soma dos dois, e o método congelado.
- [x] Dado esse mesmo pedido, quando a sessão de pagamento é criada, então
      o valor enviado ao provedor de pagamento é o `totalCents` **com
      frete** — não o subtotal dos itens. (Unitário afirma o `amountCents`
      do `createPayment`; o e2e confirma contra o dublê do Stripe que a
      sessão criada carrega o mesmo número.)
- [x] Dado um `quotedShippingCents` diferente do recálculo do servidor,
      quando faço checkout, então recebo `409` com as opções atuais, e
      nada mudou: sem pedido, sem transação, estoque e carrinho intactos.
- [x] Dado um `shippingOptionCode` que não existe, quando faço checkout,
      então recebo `409` e nada mudou.
- [x] Dado um `quotedShippingCents` ausente, negativo ou não-inteiro, ou
      um CEP malformado no endereço, quando faço checkout, então recebo
      `400`.
- [x] Dado que nenhuma opção serve o carrinho e o endereço, quando faço
      checkout, então recebo `409` e nada mudou.
- [x] Dado o provedor de frete indisponível, quando faço checkout, então
      recebo `503`, **nenhum pedido é criado** e o estoque não é
      decrementado — ao contrário da falha do provedor de pagamento, que
      deixa o pedido nascer.
- [x] Dado frete grátis por threshold, quando faço checkout, então o
      pedido tem `shippingCents: 0` **com** método preenchido, e
      `totalCents` = subtotal.

Ciclo de vida e dinheiro:

- [x] Dado um pedido `PAID`, quando um operator chama `/ship` com
      `trackingCode`, então o pedido vira `SHIPPED` com o código gravado;
      chamar sem corpo continua funcionando e deixa o rastreio nulo.
- [ ] Dado um pedido pago com frete, quando um admin chama `/refund`,
      então o valor devolvido é o total **com** frete. Sem teste próprio:
      o reembolso é emitido contra o `paymentIntent` **sem `amount`**, que
      no Stripe significa reembolso total — a mesma chamada que
      [`payments.md`](payments.md) já registra como não exercitada contra
      o provedor real.
- [x] Dado um pedido criado antes deste módulo, quando é lido, então
      `itemsSubtotalCents == totalCents`, `shippingCents == 0` e o método
      vem nulo — o valor cobrado na época não mudou. (Garantido pelo
      backfill da migration, que rodou sem tocar em `total_cents`.)

Configuração e infra:

- [x] Dada uma `SHIPPING_TABLE` inválida (JSON quebrado, código repetido,
      faixas de peso fora de ordem, prefixo não-numérico, preço negativo),
      quando o app sobe, então ele falha no boot com a mensagem apontando
      a opção problemática.
- [x] Dada `SHIPPING_TABLE` ausente com `NODE_ENV=development` ou `test`,
      quando o app sobe, então ele sobe com a tabela default embutida e
      loga aviso; com qualquer outro `NODE_ENV` (inclusive não definido),
      ele **não** sobe.
- [x] Dado `SHIPPING_FREE_ABOVE_CENTS` ou `SHIPPING_DEFAULT_WEIGHT_GRAMS`
      com valor que não é número inteiro válido, quando o app sobe, então
      ele falha no boot.
- [x] Dado o `CHECK` do banco, quando se tenta gravar um pedido cujo
      `total_cents` não é a soma das outras duas colunas, então o banco
      recusa. (`orders_total_is_items_plus_shipping` existe no banco; o e2e
      lê as três colunas de volta do Postgres e confere a identidade.)

## Estratégia de teste

O provedor da v1 **não tem terceiro atrás dele**, e a consequência é boa:
não há o que dublar, então o e2e exercita o provedor real de ponta a ponta
— cobertura melhor que a de `payments`, não pior. O que precisa de prova
aqui não é a borda de rede, é a **interface** e o **caminho do dinheiro**.

- **Unitários do `TableShippingProvider`**
  (`table-shipping.provider.spec.ts`): casamento por prefixo, prefixo longo
  recortando área menor, escolha de faixa por peso (limite inclusive, peso
  × quantidade), teto eliminando a opção, threshold de frete grátis, CEP
  sem cobertura e CEP malformado → `[]`, e a ordenação total
  (preço → prazo → código).
- **Unitários da tabela** (`shipping-table.spec.ts`): cada forma de
  configuração inválida com a mensagem que nomeia a opção, mais uma prova
  de que a própria tabela default sobrevive ao validador — um default
  quebrado só apareceria na máquina de outra pessoa.
- **Unitários do módulo** (`shipping.module.spec.ts`): a lista de permissão
  de `NODE_ENV`, a normalização de caixa/espaço igual à de payments, e os
  dois parsers numéricos.
- **Unitários do `ShippingQuoteService`**: resolução do peso default,
  carrinho vazio → `409`, provedor lançando → `503`, e as quatro respostas
  do `select` (preço bate, preço mudou, código inexistente, nada
  disponível) — inclusive que `0` é preço legítimo quando a opção é
  gratuita, e recusado quando não é.
- **Unitários do `OrdersService.checkout`**: as três colunas de dinheiro e
  o snapshot do método, `createPayment` recebendo `amountCents` **com
  frete**, divergência → `409`, código inexistente → `409`, nada
  disponível → `409`, provedor lançando → `503` sem transação, sem
  decremento e sem sessão de pagamento.
- **e2e** (`test/shipping.e2e-spec.ts`): a rota de cotação (incluindo os
  dez dígitos de CEP), os `409` de divergência, o rastreio opcional no
  `/ship`, e — a mais importante do módulo — a asserção contra o
  `OfflineStripe` de que a sessão criada carrega **itens + frete**. Pra
  isso o dublê passou a guardar o `amount_total` que lhe foi pedido: um
  dublê que esquece o valor não consegue responder "quanto isso teria
  cobrado", que é exatamente a pergunta deste módulo.
- **Buraco assumido**, no mesmo espírito dos de `payments`: não existe
  adapter HTTP de transportadora, então a adequação da interface a uma é
  **argumento, não teste**. Quando um entrar, o padrão é o do
  `STRIPE_CLIENT` — cliente HTTP atrás do próprio token, unitário
  afirmando a requisição de saída, e2e substituindo só o que vai à rede.

## Edge cases conhecidos

- **Carrinho muda entre a cotação e o checkout** (item adicionado, preço
  alterado, produto arquivado): o peso ou o subtotal mudam, o recálculo dá
  outro número e a asserção devolve `409` com as opções novas. É o mesmo
  mecanismo do drift, e cobre o caso sem lógica extra.
- **CEP da cotação diferente do CEP do checkout**: quem manda é o do
  endereço do checkout. Se o preço bater por coincidência, cobra-se o
  correto mesmo assim; se não bater, `409`.
- **CEP com formato válido mas inexistente** (`99999999`) casa o prefixo
  `"9"` e é cotado normalmente. Uma tabela não tem como saber; uma
  transportadora recusaria. Limitação assumida do provedor de tabela.
- **Produto pesado demais pra qualquer faixa** trava o checkout inteiro,
  não só aquele item — não existe envio fracionado na v1. A saída é o
  operador ampliar a tabela.
- **Peso default mascarando produto errado**: um produto de 20 kg sem
  `weightGrams` é cotado como 500 g e a loja paga a diferença. É o preço
  consciente de não bloquear o catálogo existente; a mitigação é preencher
  o peso.
- **Pedido do backfill num painel de admin** aparece com frete `R$ 0,00` e
  método nulo. Honesto: naquela época não havia frete.
- **Cancelamento parcial não existe**, então não há caso de "perdi o frete
  grátis depois de remover um item do pedido" — remover item é operação de
  carrinho, antes de o pedido nascer.
- **`mark-paid` manual de pedido com frete** não tem nada de especial: o
  total já inclui o frete e é o que o operador confere.
- **Duas opções com o mesmo preço e prazo** ficam ordenadas por código —
  arbitrário, mas estável.

## Decisões adiadas

- **Adapter de transportadora real** (Correios via CWS, Melhor Envio)
  atrás da mesma interface — o motivo de ela existir.
- **Tabela de frete no banco** com CRUD de back-office e permissões
  próprias, pra mudar frete sem redeploy.
- **`dispatch()` / compra de etiqueta e rastreio automático** — o segundo
  método da interface, quando houver adapter que o justifique.
- **Dimensões, cubagem e empacotamento** (peso cúbico dos Correios).
- **Cotação persistida com TTL** (tabela `shipping_quotes` + id no
  checkout), se a asserção de preço um dia não bastar. Exige o job de
  limpeza que o `context.md` põe depois da v1.
- **Cotação anônima** por lista explícita de itens, junto do carrinho de
  convidado.
- **Retirada na loja** como opção de `priceCents: 0` com semântica própria
  (não gera etiqueta, não tem prazo).
- **Múltiplas origens / estoque por depósito** e envio fracionado.
- **Cupom de frete grátis**, junto da feature de cupons.
- **Reembolso parcial** que devolva itens sem frete.
