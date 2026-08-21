# Spec: payments (Stripe)

## Status

`implementado`

Entregue de uma vez: migration (status `REFUNDED`, colunas de pagamento no
pedido, `payment_events` com RLS deny-all), adapter do Stripe com o SDK
atrás de token próprio, `PaymentsModule` escolhendo provedor por
configuração, o webhook e seu despacho dentro do `orders`, `/pay` e
`/refund`, unitários em cada unidade e `test/payments.e2e-spec.ts` por
cima de tudo.

Um detalhe do desenho mudou na implementação, pelo motivo que a própria
spec dá: `parseEvent` recebe o **saco de headers**, não uma string de
assinatura. Qual header carrega a assinatura é assunto do provedor
(`stripe-signature` aqui), e o controller não deve saber o nome — era a
última coisa Stripe-shaped que ainda cruzava a fronteira.

### Buracos de cobertura conhecidos

- A **criação de sessão** é verificada contra o Stripe de verdade, nos dois
  modos, por `test/payments-live.e2e-spec.ts` — que pula sozinho sem chave
  real. O que continua sem teste automatizado é o **reembolso**
  (`refunds.create`), mesma postura do `ResendMailService`. Tudo até a
  borda do SDK é testado, inclusive a verificação de assinatura de verdade.
  A checagem manual antes do deploy é
  `stripe listen --forward-to localhost:3000/payments/webhook` com uma
  compra de teste ponta a ponta.
- O `FakePaymentProvider` só tem cobertura **unitária**: desde que o
  `createTestApp` força chaves de teste, toda a suíte e2e roda contra o
  `StripePaymentProvider` (com a rede dublada). O caminho "clone novo, sem
  Stripe, checkout funciona" é garantido pelo contrato compartilhado, não
  por um e2e próprio.
- `getPayment` do fake nunca devolve `completed` — nada paga uma sessão
  falsa. A janela de cobrança dupla que esse estado fecha só é exercitável
  contra o adapter do Stripe (é o que o e2e faz, via `OfflineStripe`).
- O critério de RLS foi verificado pelo security advisor do Supabase após
  o deploy da migration (`payment_events` aparece como "RLS enabled, no
  policies", o estado desejado), não por uma sonda HTTP com a anon key —
  mesma postura de catalog e orders.
- Pagamento em duplicidade continua sendo linha de log, não dado: o
  segundo evento é registrado em `payment_events` e logado como `error`,
  mas não existe registro por tentativa. É a tabela `payments` adiada.

Decisões estruturais alinhadas antes desta spec:

1. **Checkout Session**, não PaymentIntent — e o `ui_mode` (`hosted` ou
   `embedded`) é escolhido por requisição, sobre um default de ambiente.
2. **`REFUNDED` como status novo**, em vez de reusar `CANCELLED`.
3. Estado do pagamento em **colunas do pedido + tabela de eventos**, sem
   tabela `payments` própria na v1.
4. Stripe é **opcional fora de produção** (cai no fake), obrigatório
   dentro.
5. O controller do webhook mora em **`orders`**, não em `payments` — a
   seta do grafo de módulos continua `orders → payments`.
6. Sessão expirada é **registrada, não cancela pedido**.

## Objetivo

Trocar o `FakePaymentProvider` por uma integração real com o Stripe atrás
da mesma interface `PaymentProvider`, fechando o ciclo do dinheiro —
cobrar, confirmar por webhook e reembolsar — sem que o ciclo de vida do
pedido mude. `OrdersService.markPaid` continua sendo o único caminho
`CREATED → PAID`; o que muda é que agora ele tem dois disparadores (a
rota manual que já existe e o webhook do Stripe).

## Escopo

### Entra

- `StripePaymentProvider` atrás do token `PAYMENT_PROVIDER`, criando
  Checkout Sessions (`mode: 'payment'`) com `ui_mode` `hosted` ou
  `embedded` — mesmo objeto do Stripe, mesmos eventos, mesmo reembolso
- Resposta do checkout carrega o pagamento: `url` (hosted) ou
  `clientSecret` (embedded), mais `expiresAt`
- `POST /orders/:id/pay` — (re)emite a sessão de pagamento; reusa a
  sessão aberta em vez de criar uma segunda
- Checkout **tolera** falha do provedor: o pedido nasce mesmo assim, sem
  `paymentRef`, e `/pay` é o caminho de recuperação
- `POST /payments/webhook` — assinatura verificada, corpo cru,
  idempotência por id de evento, despacho para o domínio
- Eventos tratados: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`
- Reembolso: `POST /orders/:id/refund` atrás de `orders.refund`,
  transição `PAID → REFUNDED`, devolvendo estoque — a permissão que
  `docs/specs/orders.md` reservou entra em uso aqui
- Tabela `payment_events` (dedupe + trilha de auditoria), com RLS
  deny-all na própria migration
- Expiração da sessão no cancelamento do pedido (best-effort), pra fechar
  a janela "cancelei e paguei depois"
- Configuração: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_CURRENCY`, `STRIPE_CHECKOUT_MODE`
- `FakePaymentProvider` cresce junto com a interface — continua sendo o
  provider de desenvolvimento e da maior parte do e2e

### Não entra (fica pra depois)

- **PaymentIntent + Elements** (campos de cartão próprios no storefront).
  `ui_mode: 'embedded'` já entrega layout e marca do lojista com o Stripe
  dono só dos campos de cartão — que é justamente o que mantém o escopo
  PCI em SAQ-A. Assumir os campos de cartão é outra integração inteira
  (outro objeto, outra família de eventos, outro mapeamento) e outro
  nível de compliance
- Reembolso parcial e reembolso de pedido `SHIPPED`/`DELIVERED`
  (devolução exige logística reversa, que não existe na v1)
- Disputas e chargebacks (`charge.dispute.*`)
- Reconciliação por job em background — a v1 não tem fila (BullMQ é
  roadmap pós-v1 no `claude/context.md`); o lugar da reconciliação é
  `POST /orders/:id/pay` sob demanda
- Salvar cartão / `Customer` do Stripe / pagamento com um clique
- Assinaturas, recorrência, split de pagamento (marketplace)
- Multi-moeda: a instância inteira cobra em uma moeda só (o pedido guarda
  `totalCents` sem coluna de moeda)
- Idempotency key própria na criação de sessão — o SDK já reenvia com
  chave própria (`maxNetworkRetries`), e a proteção que importa é `/pay`
  reusar a sessão aberta

## Regras de negócio / invariantes

- **O ciclo de vida do pedido não muda.** `markPaid` continua sendo a
  única porta `CREATED → PAID`, e `POST /orders/:id/mark-paid` continua
  existindo pro registro manual (transferência, Pix fora do Stripe). O
  webhook chama o mesmo método de domínio — orders não sabe que o Stripe
  existe.
- **Checkout não falha por causa do provedor.** A chamada externa
  acontece depois da transação (regra que já vem de `orders.md`), e uma
  falha dela **não** derruba o checkout: o pedido volta `CREATED` com
  `payment: null`, o erro vai pro log, e o cliente paga por
  `POST /orders/:id/pay`. É a mesma postura de `AuthService.register`,
  que cria a conta mesmo quando o e-mail de verificação não sai — o
  usuário pede o reenvio depois. Aquele "edge case não resolvido" do
  `orders.md` (pedido sem `paymentRef`) deixa de ser um buraco e vira um
  estado nomeado, com caminho de saída.
- **`/pay` reusa a sessão aberta.** Se o pedido já tem `paymentRef` e a
  sessão continua aberta no provedor, `/pay` devolve **aquela** sessão em
  vez de criar outra. Duas sessões abertas pro mesmo pedido são duas
  chances de pagar duas vezes; essa é a mitigação, e é ela — não uma
  idempotency key — que carrega o peso.

  Exceção única: se o cliente pedir um `paymentMode` diferente do da
  sessão aberta, ela é **expirada** antes de a substituta nascer — e, ao
  contrário do cancelamento, essa expiração **não** é best-effort. Se ela
  falhar, `/pay` aborta: seguir em frente é exatamente o que deixaria as
  duas pagáveis.
- **Sessão já paga não vira sessão nova.** `getPayment` distingue três
  estados (`open` / `completed` / `gone`), e não dois. Um pedido cujo
  comprador já pagou continua `CREATED` até o webhook chegar — se `/pay`
  lesse "não está aberta" como "pode criar outra", entregaria a essa mesma
  pessoa uma segunda forma de pagar o mesmo pedido. É cobrança dupla
  alcançável com nada pior que latência de webhook, então `completed`
  responde `409` e espera a confirmação.
- **A gravação da sessão é condicional em `CREATED`.** A chamada ao
  provedor acontece fora de transação, e o pedido pode ser cancelado (ou
  pago) nesse meio-tempo; gravar sem condição grudaria uma sessão pagável
  num pedido que já devolveu o estoque à prateleira. Se a condição não
  casar, a sessão recém-criada é expirada e a requisição responde `409`.
- **A assinatura do webhook é a fronteira de segurança do módulo
  inteiro.** Nada além dela distingue um evento do Stripe de um `POST`
  de qualquer pessoa da internet dizendo "o pedido X foi pago". Mesmo
  papel que o `email_verified` do Google no auto-link do auth: é a
  afirmação do provedor que substitui a nossa prova. Sem assinatura
  válida → `400`, nada é lido do corpo.
- **O corpo cru é obrigatório.** A verificação é um HMAC sobre os bytes
  exatos que o Stripe enviou; `JSON.stringify(req.body)` não reproduz
  esses bytes (ordem de chaves, espaçamento, unicode). O app sobe com
  `rawBody: true` e o handler lê `req.rawBody`. A rota não declara DTO —
  o corpo é do Stripe, não nosso, e o `ValidationPipe` global só valida
  quando existe uma classe pra validar.
- **Idempotência em duas camadas, porque o Stripe reentrega.**
  1. `payment_events` tem o id do evento (`evt_...`) como PK. Primeira
     vez insere; reentrega colide no unique.
  2. As transições de domínio já são `UPDATE` condicional
     (`WHERE status = 'CREATED'`), então mesmo um evento que escape da
     camada 1 não move um pedido duas vezes.
- **`processedAt` separa "vi" de "processei".** O registro é inserido
  antes do despacho (é isso que segura duas entregas simultâneas) e só
  ganha `processedAt` quando o despacho termina. Reentrega de um evento
  visto-mas-não-processado é **reprocessada**; de um já processado,
  respondida `200` na hora. Sem essa distinção, uma falha no meio do
  despacho deixaria o evento marcado como visto e o Stripe nunca mais o
  reentregaria — perda silenciosa de um pagamento.
- **Conflito de estado não é erro pro Stripe.** Evento de sucesso pra
  pedido já `PAID` responde `200`, não `409`: o Stripe trata qualquer
  não-2xx como falha e reentrega por até ~3 dias. Erro **inesperado**,
  ao contrário, propaga `5xx` de propósito — a reentrega do Stripe é o
  nosso mecanismo de retry, e engolir a exceção o joga fora.
- **Os eventos que cruzam a fronteira são do domínio, não do Stripe.**
  `PaymentProvider.parseEvent` devolve
  `payment.succeeded | payment.failed | payment.expired |
  payment.refunded | ignored`. Orders nunca vê um tipo do SDK do Stripe,
  e trocar de provedor (Mercado Pago, Pagar.me) continua sendo mudança só
  no módulo `payments`. É o que permite o controller morar em `orders`
  sem inverter a seta do grafo de módulos.
- **Dois refs, dois papéis.** `paymentRef` guarda a **sessão** (`cs_...`),
  que é o que o checkout cria e o que `/pay` reusa; `paymentIntentRef`
  guarda o **intent** (`pi_...`), que só existe depois do pagamento e é
  contra ele que o reembolso é emitido. Sobrescrever um com o outro
  numa coluna só faria a coluna significar "o id mais relevante agora",
  que é o tipo de campo que vira bug.
- **`clientSecret` nunca é persistido.** Ele aparece só na resposta de
  `POST /orders` e `POST /orders/:id/pay`; `GET /orders/:id` não o
  devolve, porque não o tem. Um storefront `embedded` que recarregue a
  página chama `/pay` de novo e recebe um secret novo da mesma sessão.
  `paymentUrl` (hosted) é guardado porque evita uma ida ao Stripe a cada
  leitura, e não é credencial de conta — é o próprio link de pagamento.
- **Reembolso chama o provedor antes da transação de banco**, mesma regra
  do checkout. Se o `UPDATE` falhar depois do dinheiro ter voltado, o
  evento `charge.refunded` chega e converge o pedido pra `REFUNDED` pelo
  mesmo caminho — a divergência se auto-corrige.
- **Reembolso e cancelamento são coisas diferentes.** `CANCELLED` é
  pedido não pago que foi abandonado ou desistido; `REFUNDED` é dinheiro
  que voltou. A transição `PAID → CANCELLED` continua não existindo.
- **Reembolso devolve estoque**, pelo mesmo `StockService.restock` do
  cancelamento — só `PAID` é reembolsável na v1, e pedido `PAID` ainda
  não saiu do estoque físico.
- **Pedido pago à mão não é reembolsável pela API.** `mark-paid` (Pix,
  transferência) não produz `paymentIntentRef`; `POST /orders/:id/refund`
  nesse pedido responde `409` dizendo que o estorno é manual. Fingir que
  o Stripe consegue devolver dinheiro que nunca passou por ele seria
  pior que a recusa.
- **Cancelar expira a sessão**, best-effort: sem isso um cliente pode
  cancelar (estoque volta, pode ser vendido pra outro) e pagar em
  seguida numa aba antiga. A chamada é fora da transação e falha dela só
  loga — cancelamento é operação do cliente e não pode depender do
  Stripe estar de pé.
- **Uma moeda por instância** (`STRIPE_CURRENCY`, default `brl`). O
  pedido guarda centavos sem moeda; misturar moedas exigiria uma coluna
  em `orders` e regra de conversão, que a v1 não tem.
- **Stripe é obrigatório em produção.** Fora dela, ausência das chaves
  cai no `FakePaymentProvider` com aviso no boot — clonar o repo sem
  conta no Stripe continua dando um checkout que funciona ponta a ponta.
  Com `NODE_ENV=production` e chaves faltando, o app **não sobe**: uma
  loja que silenciosamente para de cobrar é o pior modo de falha
  possível. As duas variáveis andam juntas (chave sem segredo de webhook
  = cobra e nunca confirma), mesma lógica do par do Google OAuth.
- **Rate limit do webhook é generoso de propósito**, mesmo raciocínio do
  `refresh` no auth: não é limite anti-brute-force (não há o que
  adivinhar num HMAC), é anti-flood. E aqui um `429` não perde evento —
  o Stripe reentrega com backoff. Apertar demais é que seria errado, num
  pico de vendas.
- **A trilha guarda o vocabulário do provedor.** O evento que cruza a
  fronteira é do domínio (`payment.succeeded`…), mas `payment_events.type`
  grava o nome **original** do Stripe (`checkout.session.completed`,
  `customer.created`). Por isso `PaymentEvent` carrega `providerType` ao
  lado do `type` de domínio: um serve pra despachar, o outro pra auditar.
  Sem isso, metade das linhas de uma conta real vira um `"ignored"` anônimo
  e a tabela não distingue um `customer.created` de um `charge.updated`.
- **Reembolso que chega antes do próprio pagamento é recusado, não
  engolido.** Um `charge.refunded` só conhece o intent, e quem registra o
  intent é o evento de **sucesso** — então "nenhum pedido reivindica esse
  intent" quase sempre significa que os dois chegaram fora de ordem, não
  que o pagamento é de outro sistema. Responder `200` carimbaria o evento
  como processado, encerraria a reentrega e deixaria o pedido `PAID` pra
  sempre depois de o dinheiro já ter voltado. Responder erro mantém o
  evento não-processado e faz o Stripe reentregar, quando o pagamento já
  terá registrado.
- **Cobrança dupla é logada como `error`, com o segundo intent.** Se um
  evento de sucesso chega pra pedido já `PAID` com o **mesmo** intent, é
  reentrega e não moveu nada (`log`). Com um intent **diferente**, a pessoa
  foi cobrada duas vezes: a coluna do pedido guarda o primeiro e
  `payment_events` não guarda payload, então se essa linha não nomear o
  segundo, nada nomeia — e o estorno vira caça ao dashboard.
- **`payment_events` não guarda o payload do Stripe** — só id, tipo,
  pedido e carimbos. O payload traz e-mail e nome do comprador, e a
  tabela não precisa deles pra fazer o que faz.
- **Toda tabela nova nasce com RLS deny-all na própria migration** —
  regra do projeto (`docs/security.md`, migrations de auth/catalog/orders).
- **Erro segue a convenção:** corpo malformado ou assinatura inválida →
  `400`; pedido inexistente (ou de outro dono) → `404`; sem permissão →
  `403`; requisição válida em conflito com o estado (reembolsar pedido
  não pago, pagar pedido já pago) → `409`. Uma adição do módulo: provedor
  indisponível em `/pay` → `503`. Ao contrário do checkout, emitir a
  sessão **é** a requisição inteira; responder `200` sem forma de pagar
  seria pior. No webhook, `503` é deliberado também — é o que faz o Stripe
  reentregar em vez de desistir.

## Modelo de dados (esboço Prisma)

```prisma
enum OrderStatus {
  CREATED
  PAID
  SHIPPED
  DELIVERED
  CANCELLED
  REFUNDED // novo
}

model Order {
  // ... tudo que já existe

  /// Sessão de checkout do provedor (cs_... no Stripe). Escrita no
  /// checkout e reescrita quando /pay cria uma sessão nova.
  paymentRef String? @map("payment_ref")

  /// URL da sessão hosted. Nula em ui_mode embedded — lá o que o cliente
  /// precisa é o clientSecret, que não é persistido.
  paymentUrl String? @map("payment_url")

  /// Quando a sessão atual expira. Hoje é só leitura — pra humanos e pra
  /// consulta: /pay confirma o estado com o provedor a cada chamada,
  /// porque "aberta segundo o nosso banco" e "aberta de fato" divergem
  /// (e a diferença entre paga e expirada é o que evita cobrança dupla).
  paymentExpiresAt DateTime? @map("payment_expires_at")

  /// PaymentIntent (pi_...), conhecido só quando o pagamento acontece.
  /// É contra ele que o reembolso é emitido, e é por ele que eventos de
  /// charge (que não carregam nosso orderId) acham o pedido.
  paymentIntentRef String? @map("payment_intent_ref")

  refundRef  String?   @map("refund_ref")
  refundedAt DateTime? @map("refunded_at")

  @@index([paymentIntentRef])
}

/// Todo evento de webhook que passou pela verificação de assinatura.
/// A PK é o id do evento no provedor: é ela que absorve a reentrega.
/// Sem FK para orders de propósito — um evento pode citar um pedido que
/// não existe (objeto criado no dashboard, ambiente trocado), e o
/// registro tem valor mesmo assim.
model PaymentEvent {
  id          String    @id
  type        String
  orderId     String?   @map("order_id")
  receivedAt  DateTime  @default(now()) @map("received_at")
  processedAt DateTime? @map("processed_at")

  @@index([orderId])
  @@map("payment_events")
}
```

Nota de migration: `ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDED'` não
pode ser **usado** na mesma transação que o adiciona (Postgres). A
migration só adiciona o valor e as colunas — nenhum `UPDATE` que compare
com `'REFUNDED'` entra nela.

## Superfície da API

| Método | Rota                    | Descrição                                              | Auth                                  |
| ------ | ----------------------- | ------------------------------------------------------ | ------------------------------------- |
| POST   | `/orders`               | Checkout — a resposta agora carrega `payment`          | autenticado                           |
| POST   | `/orders/:id/pay`       | (Re)emite a sessão de pagamento de um pedido `CREATED` | dono, ou `orders.update_status`       |
| POST   | `/orders/:id/refund`    | `PAID → REFUNDED`, devolve dinheiro e estoque          | `orders.refund`                       |
| POST   | `/payments/webhook`     | Eventos do Stripe                                      | público, autenticado pela assinatura  |

`POST /orders/:id/cancel`, `/mark-paid`, `/ship` e `/deliver` continuam
exatamente como estão — `cancel` ganha só a expiração best-effort da
sessão por dentro.

O controller do webhook fica em `src/orders/payment-webhook.controller.ts`
mesmo servindo `/payments/webhook`: ele reage a pagamento **no pedido**, e
é isso que mantém a seta `orders → payments` sem `forwardRef`. A URL
segue o nome que o Stripe e quem configura o dashboard esperam.

### DTOs (esboço)

```ts
type CheckoutMode = 'hosted' | 'embedded';

class CheckoutDto {
  shippingAddress: ShippingAddressDto;
  paymentMode?: CheckoutMode; // default: STRIPE_CHECKOUT_MODE
}

class PayOrderDto {
  paymentMode?: CheckoutMode; // idem
}

// Transiente — montado pelo service, não é linha de tabela.
interface PaymentSessionView {
  mode: CheckoutMode;
  url: string | null; // hosted
  clientSecret: string | null; // embedded, nunca persistido
  expiresAt: string;
}
```

Resposta do checkout e de `/pay`: o pedido de sempre, mais
`payment: PaymentSessionView | null` — `null` quando o provedor falhou e
o pedido ficou sem sessão.

### Contrato com payments (v3)

```ts
export const CHECKOUT_MODES = ['hosted', 'embedded'] as const;
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];

/** O saco de headers como chegou, sem interpretar. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentSession {
  providerRef: string; // cs_...
  mode: CheckoutMode;
  url: string | null; // sempre null no modo embedded
  clientSecret: string | null; // sempre null no modo hosted; nunca persistido
  expiresAt: Date;
}

/**
 * Três estados, não dois. `completed` é o que impede a cobrança dupla:
 * colapsá-lo em "não tem sessão aberta" se lê como "pode criar outra" — mas o
 * comprador já passou pelo checkout e só a confirmação está atrasada.
 */
export type SessionLookup =
  | { state: 'open'; session: PaymentSession }
  | { state: 'completed' }
  | { state: 'gone' };

/** Vocabulário do domínio, não do Stripe. */
export type DomainOutcome =
  | { id: string; type: 'payment.succeeded'; orderId: string | null; paymentIntentRef: string }
  | { id: string; type: 'payment.failed'; orderId: string | null }
  | { id: string; type: 'payment.expired'; orderId: string | null }
  | {
      id: string;
      type: 'payment.refunded';
      orderId: string | null;
      paymentIntentRef: string;
      refundRef: string | null;
    }
  | { id: string; type: 'ignored' };

/**
 * `type` é o desfecho de domínio (despacho); `providerType` é o nome original
 * do evento no provedor (auditoria). Ver a regra da trilha, abaixo.
 */
export type PaymentEvent = { providerType: string } & DomainOutcome;

export interface CreatePaymentInput {
  orderId: string;
  amountCents: number;
  mode?: CheckoutMode;
}

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<PaymentSession>;

  /** O que a referência guardada virou no provedor. */
  getPayment(providerRef: string): Promise<SessionLookup>;

  /** Fecha a sessão de um pedido que não é mais pagável. */
  expirePayment(providerRef: string): Promise<void>;

  refund(input: { paymentIntentRef: string }): Promise<{ refundRef: string }>;

  /**
   * Lança se a assinatura não confere. Nada é lido do corpo antes disso.
   * Recebe os headers inteiros, não a assinatura: qual header a carrega é
   * decisão do provedor, e quem chama não precisa saber o nome.
   */
  parseEvent(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent;
}
```

Mapeamento Stripe → domínio, dentro do adapter:

| Evento do Stripe                                                         | Vira                          |
| ------------------------------------------------------------------------ | ----------------------------- |
| `checkout.session.completed` / `async_payment_succeeded`, `paid` **e** com `payment_intent` | `payment.succeeded`           |
| qualquer um dos dois sem `paid` ou sem `payment_intent`                   | `ignored` (método assíncrono) |
| `checkout.session.async_payment_failed`                                   | `payment.failed`              |
| `checkout.session.expired`                                                | `payment.expired`             |
| `charge.refunded` com `refunded: true`                                    | `payment.refunded`            |
| `charge.refunded` **parcial** (`refunded: false`) ou sem `payment_intent` | `ignored`                     |
| qualquer outro                                                            | `ignored`                     |

Os dois eventos de sucesso caem no mesmo `case`: o filtro de `payment_status`
vale pros dois, porque boleto e Pix completam a sessão antes de pagar.

**Reembolso parcial é `ignored` de propósito.** O Stripe dispara
`charge.refunded` também quando só parte do valor volta, e nesse caso
`refunded` continua `false`. Tratar isso como reversão total marcaria o
pedido inteiro como `REFUNDED` e devolveria **todos** os itens ao estoque
— inventário inventado — com a maior parte do dinheiro ainda retida.
Emitir reembolso parcial está fora de escopo, mas o evento chega
independente de a gente suportar a feature.

`orderId` sai de `client_reference_id` nos eventos de **sessão**; nos de
**charge** sai de `metadata.orderId` (que vai em `payment_intent_data` pra
ser herdado) e, quando ele não vem — que é o caso real, ver os buracos de
cobertura —, o pedido é achado pelo `paymentIntentRef`.

O `CheckoutMode` do domínio (`hosted` | `embedded`) **não** é o valor que
vai pro Stripe: na versão de API atual do SDK os valores são
`hosted_page` e `embedded_page` (havia `hosted`/`embedded` em versões
anteriores, e existem ainda `elements` e `form`). A tradução é uma linha
dentro do adapter, e é exatamente por isso que o vocabulário que cruza a
fronteira é nosso — o dia em que o Stripe renomear de novo, nada fora de
`payments` fica sabendo. Duas consequências práticas do modo, também
escondidas no adapter: `hosted_page` recebe `success_url` + `cancel_url`
e devolve `url`; `embedded_page` **exige** `return_url`, recusa os outros
dois e devolve `client_secret`.

### Configuração necessária

| Variável                | Para quê                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Cobrar. Sem ela, fora de produção, o app sobe com o fake e avisa; em produção, não sobe.      |
| `STRIPE_WEBHOOK_SECRET` | Verificar assinatura. Anda junto com a chave — uma sem a outra cobra e nunca confirma.        |
| `STRIPE_CURRENCY`       | Opcional, default `brl`. Uma moeda por instância.                                              |
| `STRIPE_CHECKOUT_MODE`  | Opcional, default `hosted`. Só o default; cada requisição pode escolher.                        |

`success_url`/`cancel_url` (hosted) e `return_url` (embedded) saem do
`APP_URL` que já existe — são páginas do frontend, mesma lógica dos links
de verificação de e-mail. Nenhuma variável nova pra isso.

## Critérios de aceitação

Checkout e sessão:

- [x] Dado carrinho válido e Stripe configurado, quando faço checkout,
      então recebo `201` com pedido `CREATED`, `payment.url` preenchida e
      `paymentRef` começando em `cs_`.
- [x] Dado `paymentMode: "embedded"`, quando faço checkout, então a
      resposta traz `payment.clientSecret` e `payment.url` nula — e o
      mesmo `cs_` fica em `paymentRef`.
- [x] Dado o provedor indisponível, quando faço checkout, então ainda
      recebo `201` com pedido `CREATED` e `payment: null`; estoque
      decrementado e carrinho consumido como sempre, erro no log.
- [x] Dado um pedido `CREATED` sem sessão, quando chamo `/pay`, então uma
      sessão é criada e devolvida.
- [x] Dado um pedido `CREATED` com sessão ainda aberta, quando chamo
      `/pay`, então recebo a **mesma** sessão — nenhuma sessão nova é
      criada no provedor.
- [x] Dado um pedido `PAID`, `CANCELLED` ou `REFUNDED`, quando chamo
      `/pay`, então recebo `409`.
- [x] Dado um pedido cuja sessão **já foi paga** mas cujo webhook ainda
      não chegou (pedido segue `CREATED`), quando chamo `/pay`, então
      recebo `409` e **nenhuma** sessão nova é criada — e o webhook
      atrasado ainda conclui o pedido normalmente depois.
- [x] Dado que o pedido saiu de `CREATED` enquanto o provedor respondia,
      quando a sessão ia ser gravada, então nada é gravado, a sessão órfã
      é expirada e recebo `409`.
- [x] Dado o provedor indisponível, quando chamo `/pay`, então recebo
      `503` e o pedido continua `CREATED`.
- [x] Dado o pedido de outro cliente, quando chamo `/pay`, então recebo
      `404` sem `orders.read`, e `200` com `orders.update_status`.

Webhook:

- [x] Dado um `checkout.session.completed` assinado corretamente, quando
      chega no webhook, então o pedido vira `PAID` com `paidAt` e
      `paymentIntentRef` preenchidos, e a resposta é `200`.
- [x] Dada assinatura inválida (ou header ausente), quando chega no
      webhook, então recebo `400` e nada muda no banco.
- [x] Dado o mesmo evento reentregue, quando chega de novo, então recebo
      `200`, `paidAt` não muda e existe exatamente uma linha em
      `payment_events`.
- [x] Dado um evento de sucesso pra pedido já `PAID`, quando chega, então
      a resposta é `200` (não `409`).
- [x] Dado um evento cujo `orderId` não existe, quando chega, então
      recebo `200`, o evento é registrado e nada mais acontece.
- [x] Dado que o webhook é público, quando chamo sem token algum, então
      não recebo `401` — e `POST /orders/:id/mark-paid` continua exigindo
      `orders.update_status`.
- [x] Dado um `checkout.session.expired`, quando chega, então o evento é
      registrado e o pedido continua `CREATED` com o estoque retido.

Reembolso:

- [x] Dado um pedido `PAID` pelo Stripe, quando um admin chama
      `/refund`, então o provedor recebe o refund do `pi_`, o pedido vira
      `REFUNDED` com `refundedAt`/`refundRef`, e o estoque volta.
- [x] Dado o mesmo pedido, quando um operator (sem `orders.refund`) ou o
      próprio cliente chama `/refund`, então recebe `403`.
- [x] Dado um pedido `CREATED`, `SHIPPED`, `DELIVERED` ou já `REFUNDED`,
      quando chamo `/refund`, então recebo `409`.
- [x] Dado um pedido `PAID` por `mark-paid` (sem `paymentIntentRef`),
      quando chamo `/refund`, então recebo `409` dizendo que o estorno é
      manual, e nenhuma chamada é feita ao provedor.
- [x] Dado um `charge.refunded` originado no dashboard do Stripe, quando
      chega no webhook, então o pedido `PAID` vira `REFUNDED` pelo mesmo
      caminho; reentregue, responde `200` sem devolver estoque de novo.
- [x] Dado um `charge.refunded` **parcial** (`refunded: false`), quando
      chega no webhook, então o pedido continua `PAID`, o estoque não
      volta, e o evento é registrado mesmo assim.
- [x] Dado um `charge.refunded` cujo intent ainda não está registrado em
      nenhum pedido, quando chega, então recebo `503` e o evento fica
      **não-processado** — e quando o pagamento registra, a reentrega do
      mesmo evento conclui o reembolso.

Cancelamento:

- [x] Dado um pedido `CREATED` com sessão aberta, quando o cliente
      cancela, então a sessão é expirada no provedor — e o cancelamento
      acontece mesmo se essa chamada falhar.

Configuração e infra:

- [x] Dado nenhum `STRIPE_SECRET_KEY` e `NODE_ENV` igual a `development`
      ou `test`, quando o app sobe, então ele sobe com o fake e loga
      aviso (o `FakePaymentProvider` satisfaz o mesmo contrato — cobertura
      unitária, ver buracos conhecidos).
- [x] Dado `NODE_ENV=production` sem as variáveis do Stripe, quando o app
      tenta subir, então ele falha no boot (verificado também rodando o
      build de verdade: sai com código 1).
- [x] Dado `NODE_ENV` **não definido**, `staging`, `prod` ou com caixa
      diferente, e sem as variáveis do Stripe, quando o app tenta subir,
      então ele **também** falha — a lista é de permissão, não de
      proibição, porque o fake aceita webhook sem assinatura.
- [x] Dada a tabela `payment_events`, quando consultada com a anon key do
      Supabase, então nada é retornado (RLS deny-all na própria
      migration).

## Estratégia de teste

O problema é o mesmo do `ResendMailService` (o e2e troca o provedor por
um fake porque o real exige chave e mandaria e-mail de verdade), **mas
com um final melhor**: a parte mais frágil do módulo — verificação de
assinatura + corpo cru — é HMAC puro com um segredo que nós escolhemos,
então dá pra testar de verdade, sem conta no Stripe e sem rede.

- O cliente do Stripe é injetado por token próprio (`STRIPE_CLIENT`), não
  construído dentro do provider. Isso é o que torna o adapter testável em
  unidade (afirmar os parâmetros da sessão: valor, moeda,
  `client_reference_id`, `ui_mode`, urls) e o que permite o e2e trocar só
  o que toca a rede.
- **Unitários**: mapeamento de cada evento do Stripe pro evento de
  domínio; assinatura inválida lança; reuso de sessão em `/pay`;
  checkout tolerando falha do provedor; `refund` recusando pedido sem
  intent; idempotência do despacho (evento repetido não move o pedido
  duas vezes).
- **e2e**: `createTestApp` passa a criar o app com `rawBody: true` e
  substitui **apenas** `checkout.sessions.create/retrieve/expire` e
  `refunds.create` por stubs — `webhooks.constructEvent` continua sendo o
  do SDK. Os testes assinam o payload com
  `stripe.webhooks.generateTestHeaderString({ payload, secret })`, que é
  o helper oficial pra exatamente isso. Resultado: a verificação de
  assinatura real, o corpo cru real, o `@Public()` real e a dedupe real
  ficam cobertos.
- **Suíte live (opt-in)**: `test/payments-live.e2e-spec.ts` cria Checkout
  Sessions **de verdade** na conta configurada, nos dois modos. É o único
  teste que prova que o Stripe **aceita** os parâmetros que montamos —
  nenhum dublê pode falsificar isso, e um campo errado só apareceria como
  um `400` dele (ou, pior, como `payment: null` em produção). Ela lê a
  chave do **arquivo** `.env`, não de `process.env`, justamente porque o
  `createTestApp` força `sk_test_offline`; sem chave real, `describe.skip`
  — clone novo e CI seguem verdes e offline. Rodar com
  `pnpm test:e2e -- payments-live`.
- **Fixture real**: `test/fixtures/charge-refunded.json` é um
  `charge.refunded` capturado com `stripe trigger` e congelado. Serve de
  contraprova às fixtures escritas à mão: nessa versão de API o evento
  **não** traz `refunds` expandido nem `metadata` no charge — é por isso
  que `refundRef` volta `null` e o pedido é achado pelo intent.
- **Buraco que continua**: a chamada de **reembolso** (`refunds.create`)
  não é exercida contra o Stripe real — mesma postura honesta do Resend.
  A verificação manual antes do deploy é o
  `stripe listen --forward-to localhost:3000/payments/webhook` com uma
  compra de teste ponta a ponta.

## Edge cases conhecidos

- **Pagou duas vezes.** Duas sessões abertas pro mesmo pedido (o reuso em
  `/pay` torna isso raro, não impossível) e ambas pagas: a primeira leva
  o pedido a `PAID`, a segunda é registrada em `payment_events`, loga
  `error` e **não** move nada. O dinheiro extra existe e precisa de
  estorno manual pelo dashboard. Fica visível na tabela de eventos; a
  correção completa é a tabela `payments` por tentativa, adiada.
- **Pagou depois de cancelar.** Janela quase fechada pela expiração da
  sessão no cancelamento, mas se um evento de sucesso chegar pra pedido
  `CANCELLED`: registrado, logado como `error`, pedido **não** volta pra
  `PAID` (o estoque já pode ter sido vendido). Estorno manual.
- **Valor abaixo do mínimo do Stripe** (BRL tem piso): a criação da
  sessão falha, o pedido nasce sem `payment` e `/pay` vai falhar
  igual. O conserto é uma regra de valor mínimo de pedido em `orders`,
  que a v1 não tem.
- **Sessão expira com o pedido segurando estoque** — decisão consciente
  (opção "registrar apenas"): o pedido `CREATED` continua igual a
  qualquer pedido abandonado da v1, e a saída é o cancelamento manual que
  já existe.
- **Evento fora de ordem** (`charge.refunded` antes de
  `checkout.session.completed`): as transições são condicionais, então o
  refund em pedido não-`PAID` não aplica; o evento fica registrado com
  `processedAt` e a divergência aparece no log.
- **Payload maior que o limite do body parser** (100kb, default do
  Express): evento gigante seria rejeitado antes do handler. Elevar o
  limite só nessa rota se aparecer.
- **`mark-paid` manual num pedido que também tem sessão aberta**: o
  pedido vira `PAID` e a sessão continua aberta até expirar. Pagável.
  Mesma família do "pagou depois de cancelar" e mesma saída; expirar a
  sessão no `mark-paid` também é uma linha, e entra se incomodar. (O
  `cancel` faz isso; o `mark-paid` não — a assimetria é consciente, mas
  é a mesma janela.)
- **Sessão órfã**: se a gravação no banco falhar depois de o provedor ter
  criado a sessão, ela existe lá, pagável, e nós não guardamos a
  referência pra expirar. O comprador não chega nela pela API, mas ela
  vaza (e conta pro limite de sessões do Stripe).
- **Ambiente trocado** (evento de test mode chegando no endpoint de
  produção): a assinatura não confere, porque o segredo é por endpoint →
  `400`. Nada especial a fazer.

## Decisões adiadas

Os quatro primeiros itens saíram de uma revisão feita depois da entrega
(2026-07-28) e estão registrados aqui, e não em código, porque cada um
depende de uma decisão que não é só técnica.

- **Conferir valor e moeda no `payment.succeeded`.** Hoje `markPaid`
  confia no `client_reference_id` e não compara `amount_total` com
  `totalCents`. Não é explorável do jeito que está — o `unit_amount` é
  fixado no servidor, `adjustable_quantity` e cupons estão desligados, e
  test/live têm segredos de webhook distintos — mas é a checagem que
  mantém isso verdadeiro se qualquer uma dessas coisas mudar, ou se
  alguém criar um Payment Link com o `client_reference_id` de um pedido
  existente. Custa carregar `amountTotal`/`currency` no evento de domínio.
- ~~**`trust proxy` / chave de rate limit.**~~ **Resolvido no deploy**
  (2026-08-21). A topologia de que a correção dependia passou a existir:
  `TRUST_PROXY_HOPS` é obrigatória fora de `development`/`test`, com a
  mesma lista de permissão das outras duas guardas de boot, e o app
  declara `trust proxy` a partir dela (`src/trust-proxy.ts`,
  [`deploy.md`](deploy.md)). É um número de saltos, não `true`, porque
  `true` faz o Express confiar no `X-Forwarded-For` que o **cliente**
  escreve — trocar um balde compartilhado por um balde forjável não
  seria correção.
- **Serializar `/pay` concorrente.** Duas chamadas simultâneas num pedido
  sem `paymentRef` leem `null` as duas e criam duas sessões — a gravação
  condicional em `CREATED` não separa esse caso, porque as duas casam. O
  conserto é um `SELECT … FOR UPDATE` (ou um claim condicional) segurando
  a linha durante a chamada externa. Requer duplo-clique ou retry de
  cliente, e o dano é o mesmo da cobrança dupla.
- **A reentrega não preenche o `order_id` da linha de auditoria.** O
  `claim` só insere; um evento visto quando o pedido ainda não era
  resolvível (o caso do reembolso fora de ordem, acima) fica com
  `order_id NULL` pra sempre, mesmo depois de reprocessar com sucesso. O
  evento **é** aplicado — só a trilha fica menos navegável.
- **Reembolso concorrente.** Dois `/refund` simultâneos chegam os dois ao
  provedor; o Stripe recusa o segundo com `charge_already_refunded`, então
  o dinheiro não volta duas vezes — mas quem garante é ele, não a gente, e
  a recusa sobe como `500` em vez do `409` que a convenção promete.
- **Tabela `payments`** (uma linha por tentativa, com `status` próprio) —
  o que tornaria pagamento duplicado um dado em vez de uma linha de log.
  Entra se o volume mostrar que acontece.
- **PaymentIntent + Elements** como terceiro modo, pra quem quiser os
  campos de cartão próprios (e o compliance que vem junto).
- **Reembolso parcial** e reembolso pós-envio, junto de um fluxo de
  devolução de verdade.
- **Disputas/chargebacks** (`charge.dispute.created`) — hoje nem
  registradas.
- **Reconciliação em background** (varrer pedidos `CREATED` com sessão
  paga que perdemos): só faz sentido com a fila do roadmap pós-v1. Até
  lá, `/pay` sob demanda cobre.
- **Cancelamento automático de sessão expirada** (a opção que devolveria
  estoque sozinha) — depende de amarrar o evento à sessão corrente pra
  não cancelar pedido de quem está pagando numa sessão nova.
- **`order_events`** como trilha de auditoria unificada — hoje
  `payment_events` guarda o lado do provedor e os timestamps do pedido
  guardam o lado do domínio.
- **Idempotency key explícita** na criação de sessão, se algum dia o
  reuso de sessão não bastar.
