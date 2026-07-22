# Mapa de módulos internos

> Status: quase todo real. `auth`, `catalog`, `orders`, `payments`
> (Stripe de verdade), `prisma` e `mail` existem; `shipping` continua
> desenho-alvo — a seta `orders → shipping` é intenção, não código. Se um
> módulo passar a depender de outro de um jeito não previsto aqui, o
> diagrama está desatualizado, não o código.

Setas sólidas = depende de (chamada direta via interface/serviço
injetado). Setas tracejadas = usa utilitário compartilhado, sem
acoplamento de domínio.

```mermaid
flowchart LR
    auth["auth"]
    catalog["catalog"]
    orders["orders"]
    payments["payments"]
    shipping["shipping"]
    common["common"]
    prisma["prisma"]
    mail["mail"]

    orders --> catalog
    orders --> payments
    orders --> shipping

    auth --> prisma
    auth --> mail
    catalog --> prisma

    auth -.-> common
    catalog -.-> common
    orders -.-> common
    payments -.-> common
    shipping -.-> common
```

## Regras de dependência

- `orders` é o orquestrador: conhece `catalog` (checar produto/estoque),
  `payments` (cobrar) e `shipping` (calcular frete — ainda alvo). Nenhum
  desses três conhece `orders` de volta. O contrato do lado de `catalog`
  está em uso: `CatalogModule` exporta `ProductsService` (`findByIds`,
  a leitura em lote do que está sendo comprado) e `StockService`
  (`decrement`, o UPDATE condicional atômico do checkout, e `restock`,
  a devolução do cancelamento — ambos aceitam um client de transação
  pro checkout/cancelamento serem atômicos através da fronteira) —
  `orders` nunca toca nas tabelas do catálogo.
- `catalog`, `payments` e `shipping` não se conhecem entre si.
- `auth` não depende de nenhum módulo de domínio. Os outros módulos
  usam `auth` só através de decorators (`@Public()`,
  `@RequirePermissions(...)`, `@CurrentUser()`) e do
  `OptionalJwtAuthGuard` (rota pública que enxerga mais quando o caller
  prova quem é — caso das leituras do catálogo), nunca importando
  serviços internos de `auth` diretamente — por isso não aparece como
  seta sólida saindo deles.
- `prisma` é infraestrutura, não domínio: expõe `PrismaService` como
  módulo global. `auth` depende dele de verdade (seta sólida) — lê
  usuário, papel e refresh token — e `catalog` também (produtos,
  categorias, estoque); ele não conhece ninguém de volta.
- `mail` é infraestrutura também: expõe uma interface (`MailService`) via
  token, com o adapter do Resend escondido atrás — mesmo padrão de
  `payments`/`shipping`. `auth` depende dela pra verificação de e-mail e
  reset de senha. Trocar de provedor é mudança só no módulo `mail`.
- `common` é via de mão única: qualquer módulo pode usar filtros/pipes/
  decorators de `common`, mas `common` nunca importa de um módulo de
  domínio.
- `payments` e `shipping` expõem só a interface (`PaymentProvider`,
  `ShippingProvider`); o adapter concreto (Stripe, transportadora X)
  fica escondido atrás dela — trocar de provedor não deve tocar em
  `orders`. `payments` já existe nessa forma completa: o token
  `PAYMENT_PROVIDER` com `StripePaymentProvider` atrás (ou
  `FakePaymentProvider`, quando não há chave configurada e o ambiente não
  é produção), mesmo padrão do `mail`. Não é `@Global` de propósito: só
  `orders` cobra dinheiro, e importar o módulo é o que mantém essa
  dependência visível no grafo.
- **O webhook de pagamento é rota do `orders`**, não do `payments`, mesmo
  servindo `/payments/webhook`. Reagir a um pagamento é mudar um
  **pedido**: hospedar o controller em `payments` faria `payments`
  depender de `orders`, que é ciclo e o contrário da regra acima. O que
  mantém isso honesto é o contrato — `PaymentProvider.parseEvent` verifica
  a assinatura e devolve um evento do **domínio**
  (`payment.succeeded`, `payment.refunded`…), então nenhum tipo do Stripe
  atravessa a fronteira. Consequência boa de lado: `payments` continua sem
  tocar em banco; a tabela `payment_events` (dedupe de reentrega) é do
  `orders`.
- `payments` depende do SDK do Stripe atrás de um token próprio
  (`STRIPE_CLIENT`) em vez de construí-lo dentro do adapter. É o que
  permite testar o adapter em unidade e, no e2e, substituir **só** as duas
  chamadas que vão à rede — a verificação de assinatura continua sendo a
  do SDK. Ver [`docs/specs/payments.md`](../specs/payments.md).

Quando isso for validado com lint (boundaries entre módulos), essa
seção diz o que a regra deve proibir.
