# Spec: cart-totals (totais do carrinho e da cotação)

## Status

`implementado`

Entregue de uma vez: a aritmética extraída pra `src/orders/money.ts`, os
dois totais no carrinho, o subtotal e o `orderTotalCents` na cotação,
unitários em cada unidade e e2e nos dois pontos onde a afirmação precisa
de duas rotas.

Uma coisa mudou durante a implementação, e veio do compilador antes de vir
do teste: a função `itemsSubtotalCents` **saiu** de
`shipping-quote.service.ts`. `CartService` passou a precisar dela e
`ShippingQuoteService` já depende de `CartService`, o que fecharia um
ciclo de import em runtime — o `design:paramtypes` do construtor é
referência de valor, não só de tipo. Um módulo sem classe e sem injeção
não participa de ciclo nenhum, e de quebra `itemCount` nasceu ao lado da
soma que ela sempre foi.

Uma segunda decisão, essa por omissão deliberada: `GET /cart` **não**
ganhou total do pedido. Sem CEP não há frete, e um "total" sem frete é
exatamente o número que um checkout não pode exibir.

Verificado: 462 testes unitários verdes (eram 457 antes deste PR),
`lint:check`, `typecheck`, `build`, e a suíte e2e inteira — 179 testes em
8 arquivos, contra o Supabase de **desenvolvimento**
(`commerce-core-dev`), confirmado antes de rodar porque a suíte dá
`TRUNCATE` no banco pra onde `DATABASE_URL` aponta.

O caso de frete grátis (`priceCents: 0` ⇒ `orderTotalCents` igual ao
subtotal) é coberto no unitário e **não** no e2e: a tabela de frete é
lida do ambiente no boot, então produzir uma opção gratuita no e2e exigiria
subir um segundo app com outra `SHIPPING_TABLE` — cerimônia que não paga o
que já está provado uma camada abaixo.

## Objetivo

Fazer o backend devolver os totais que toda tela de compra exibe — subtotal
dos itens, quantidade de peças e o total do pedido por opção de frete — em
vez de deixar cada front-end somar `priceCents × quantity` no navegador.
Aritmética de dinheiro no cliente é um buraco do backend, não um exercício
de front-end: toda loja que implantar este core tem um carrinho com um total
dentro.

## Escopo

### Entra

- `itemsSubtotalCents` e `itemCount` em `CartResponse` (`GET /cart` e todas
  as rotas de escrita do carrinho, que já devolvem o carrinho inteiro)
- `itemsSubtotalCents` em `ShippingQuoteResponse` (`POST /shipping/quote`)
- `orderTotalCents` em cada opção de `ShippingQuoteResponse.options` —
  `itemsSubtotalCents + option.priceCents`
- Uma única definição do subtotal, compartilhada por carrinho, cotação e
  checkout

### Não entra (fica pra depois)

- Desconto, cupom, valor de frete grátis por faixa — não existe regra de
  desconto na v1, e `itemsSubtotalCents` é subtotal de itens, não "total a
  pagar menos algo"
- Impostos destacados — preço no Brasil já é o preço final ao consumidor
- Peso total do carrinho na resposta — o front não precisa dele; quem
  precisa é o provedor de frete, atrás do token
- Congelar preço no carrinho — carrinho não guarda dinheiro; quem congela é
  o checkout, e isso não muda aqui
- Total do pedido em `GET /cart` — sem CEP não há frete, e um "total" sem
  frete no meio de um checkout é a mentira que este spec existe pra evitar

## Regras de negócio / invariantes

- **O subtotal é do servidor, sempre, e é calculado sobre o preço vivo do
  catálogo.** O carrinho não congela preço (`docs/specs/orders.md`); ele
  reporta o preço de agora. Se o preço do produto mudar depois que a linha
  entrou no carrinho, o subtotal acompanha — porque é isso que o checkout
  vai cobrar.
- **Existe uma só definição de subtotal.** A mesma função que o checkout usa
  pra congelar `itemsSubtotalCents` no pedido é a que o carrinho e a cotação
  usam pra exibir. Duas somas sutilmente diferentes colocariam a faixa de
  frete grátis e o valor gravado fora de sintonia — e o cliente veria um
  número na tela e outro na fatura.
- **`orderTotalCents` é o que vai ser cobrado.** Para a opção escolhida,
  `orderTotalCents` da cotação tem que ser igual ao `totalCents` do pedido
  que `POST /orders` cria em seguida, com os mesmos itens e o mesmo CEP.
  Qualquer divergência entre os dois é bug, e é por isso que existe um teste
  que compara os dois números diretamente.
- **Carrinho vazio devolve `0`, nunca `null` e nunca ausente.** Um badge de
  carrinho que precisa tratar `undefined` é um contrato mal escrito.
- **Frete zero é frete de verdade.** Uma opção com `priceCents: 0` tem
  `orderTotalCents` igual ao subtotal — não é campo faltando, é frete
  grátis, que já é um caso legítimo na tabela (`docs/specs/shipping.md`).
- **Tudo aqui é aditivo.** Nenhum campo existente muda de significado,
  nenhum consumidor quebra. `POST /shipping/quote` continua respondendo
  `options`; ela só ganha um irmão e um campo por opção.
- **`itemCount` é soma de quantidades, não contagem de linhas.** Duas
  camisetas e uma calça são 3, não 2. É o número que vai no badge.

## Superfície da API

| Método | Rota | Descrição | Auth |
| ------ | ---- | --------- | ---- |
| GET | `/cart` | resposta ganha `itemsSubtotalCents` e `itemCount` | autenticada |
| POST | `/cart/items` | mesma resposta (carrinho inteiro) | autenticada |
| PATCH | `/cart/items/{productId}` | mesma resposta | autenticada |
| DELETE | `/cart/items/{productId}` | mesma resposta | autenticada |
| DELETE | `/cart` | mesma resposta, com os dois totais em `0` | autenticada |
| POST | `/shipping/quote` | resposta ganha `itemsSubtotalCents`, e cada opção ganha `orderTotalCents` | autenticada |

Nenhuma rota nova. Nenhuma migration: os três números saem de dados que já
estão em memória no momento da resposta.

### DTOs (esboço)

```ts
export class CartResponse {
  items: CartItemResponse[];

  /** Soma de product.priceCents × quantity, com preço VIVO do catálogo. */
  itemsSubtotalCents: number;

  /** Soma das quantidades. Carrinho vazio é 0. */
  itemCount: number;
}

export class ShippingOptionResponse {
  code: string;
  label: string;
  priceCents: number;
  estimatedDays: number | null;
  carrier: string | null;

  /** itemsSubtotalCents + priceCents — o que POST /orders vai cobrar. */
  orderTotalCents: number;
}

export class ShippingQuoteResponse {
  options: ShippingOptionResponse[];

  /** O mesmo subtotal de GET /cart, medido sobre o mesmo carrinho. */
  itemsSubtotalCents: number;
}
```

A função compartilhada sai de `shipping-quote.service.ts` para um módulo
próprio, `src/orders/money.ts`:

```ts
export function itemsSubtotalCents(
  items: readonly { unitPriceCents: number; quantity: number }[],
): number;

export function itemCount(
  items: readonly { quantity: number }[],
): number;
```

O motivo da mudança de casa é mecânico e vale registrar: `CartService`
passa a precisar da soma, e `ShippingQuoteService` já depende de
`CartService`. Deixar a função onde estava criaria um ciclo de import em
runtime (o `design:paramtypes` do construtor é referência de valor, não só
de tipo). Um módulo sem classe e sem injeção não pode participar de ciclo
nenhum.

## Critérios de aceitação

- [ ] Dado um carrinho com 2 × R$ 49,90 e 1 × R$ 25,00, quando leio
      `GET /cart`, então `itemsSubtotalCents` é `12480` e `itemCount` é `3`
- [ ] Dado um carrinho vazio (ou usuário que nunca adicionou nada), quando
      leio `GET /cart`, então `itemsSubtotalCents` é `0` e `itemCount` é `0`
      — presentes, não `null`, não ausentes
- [ ] Dado um item no carrinho e um preço de produto alterado depois pelo
      back-office, quando leio `GET /cart`, então o subtotal reflete o preço
      **novo** — o carrinho não congela preço
- [ ] Dado `DELETE /cart`, quando esvazio, então a resposta traz
      `items: []`, `itemsSubtotalCents: 0` e `itemCount: 0`
- [ ] Dados `POST /cart/items`, `PATCH /cart/items/{id}` e
      `DELETE /cart/items/{id}`, quando qualquer um deles responde, então os
      dois totais vêm junto e já refletem a mudança feita
- [ ] Dado um carrinho e um CEP atendido, quando peço `POST /shipping/quote`,
      então a resposta traz `itemsSubtotalCents` igual ao de `GET /cart`
- [ ] Dada uma cotação com opções, quando leio cada opção, então
      `orderTotalCents` é exatamente `itemsSubtotalCents + priceCents`
- [ ] Dada uma opção de frete com `priceCents: 0`, quando leio a cotação,
      então `orderTotalCents` é igual ao `itemsSubtotalCents` — frete grátis
      é preço, não ausência de preço
- [ ] Dado que escolhi uma opção e chamei `POST /orders` com ela, quando o
      pedido é criado, então `order.totalCents` é igual ao `orderTotalCents`
      que a cotação anunciou para aquela opção, e `order.itemsSubtotalCents`
      é igual ao `itemsSubtotalCents` da cotação
- [ ] Dado um carrinho vazio, quando peço `POST /shipping/quote`, então
      continua `409` — nada mudou nesse caminho
- [ ] O documento OpenAPI regenerado descreve `itemsSubtotalCents`,
      `itemCount` e `orderTotalCents`

## Estratégia de teste

Unitário onde a aritmética mora — `money.spec.ts` para as duas funções,
`cart.service.spec.ts` para o carrinho vivo, `shipping-quote.service.spec.ts`
para a cotação — e e2e só onde a afirmação precisa de duas rotas para
existir.

A afirmação que mais importa é a última: `orderTotalCents` da opção
escolhida contra `totalCents` do pedido criado. Ela só pode ser feita no
nível HTTP, porque é exatamente a costura entre duas rotas que o front-end
vai usar em sequência — e é a única forma de o número anunciado e o número
cobrado divergirem sem ninguém notar.

## Edge cases conhecidos

- **Overflow de `Int`.** `itemsSubtotalCents` no banco é `INTEGER`
  (2.147.483.647 = R$ 21.474.836,47). O carrinho tem um teto implícito —
  999 unidades por linha — mas nada limita o número de linhas. Um carrinho
  absurdo estoura no `INSERT` do pedido, não na exibição. Fica como está: o
  limite é o mesmo que a coluna do pedido já tinha antes deste spec, e
  mudar tipo de coluna de dinheiro merece o seu próprio PR.
- **Produto que saiu do catálogo com a linha ainda no carrinho.** O subtotal
  continua somando a linha, porque o preço vivo continua existindo
  (`status` é que mudou). É consistente com o que a resposta já fazia: o
  carrinho reporta a verdade de agora e deixa o aviso para o cliente; quem
  recusa é o checkout, com `409`.
- **`itemCount` versus estoque.** Um carrinho pode conter mais unidades do
  que existem em estoque; `itemCount` conta o que está no carrinho, não o
  que dá pra comprar. Já é assim para `quantity` linha a linha.
- **Cotação e carrinho lidos em requisições diferentes.** Se o preço mudar
  entre uma e outra, os dois `itemsSubtotalCents` divergem — e é o
  comportamento certo, cada um reporta o instante em que foi medido. O
  checkout re-mede e é ele quem congela.

## Decisões adiadas

- **Total do pedido em `GET /cart`.** Exigiria um CEP, e um CEP não é
  propriedade do carrinho. Se um dia existir endereço padrão de usuário,
  isso vira uma decisão de produto, não de cálculo.
- **Peso total na cotação.** Útil para depurar frete, inútil para exibir.
  Entra quando alguém precisar dele.
- **`itemsSubtotalCents` formatado (`R$ 124,80`).** Formatação é
  localização, e localização é do cliente. A API fala centavos inteiros em
  toda a superfície e não abre exceção aqui.
