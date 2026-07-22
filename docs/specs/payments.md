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

- As duas chamadas HTTP ao Stripe (criar sessão, reembolsar) não são
  exercidas por teste automatizado — mesma postura do `ResendMailService`.
  Tudo até a borda do SDK é testado, inclusive a verificação de assinatura
  de verdade. A checagem manual antes do deploy é
  `stripe listen --forward-to localhost:3000/payments/webhook` com uma
  compra de teste ponta a ponta.
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
- **`payment_events` não guarda o payload do Stripe** — só id, tipo,
  pedido e carimbos. O payload traz e-mail e nome do comprador, e a
  tabela não precisa deles pra fazer o que faz.
- **Toda tabela nova nasce com RLS deny-all na própria migration** —
  regra do projeto (`docs/security.md`, migrations de auth/catalog/orders).
- **Erro segue a convenção:** corpo malformado ou assinatura inválida →
  `400`; pedido inexistente (ou de outro dono) → `404`; sem permissão →
  `403`; requisição válida em conflito com o estado (reembolsar pedido
  não pago, pagar pedido já pago) → `409`.

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

  /// Quando a sessão atual expira. Deixa /pay decidir entre reusar e
  /// criar sem perguntar ao Stripe.
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

### Contrato com payments (v2)

```ts
export type CheckoutMode = 'hosted' | 'embedded';

/** O saco de headers como chegou, sem interpretar. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentSession {
  providerRef: string; // cs_...
  mode: CheckoutMode;
  url?: string;
  clientSecret?: string;
  expiresAt: Date;
}

/** Vocabulário do domínio, não do Stripe. */
export type PaymentEvent =
  | { id: string; type: 'payment.succeeded'; orderId?: string; paymentIntentRef: string }
  | { id: string; type: 'payment.failed'; orderId?: string }
  | { id: string; type: 'payment.expired'; orderId?: string }
  | { id: string; type: 'payment.refunded'; paymentIntentRef: string; refundRef: string }
  | { id: string; type: 'ignored' };

export interface PaymentProvider {
  createPayment(input: {
    orderId: string;
    amountCents: number;
    mode?: CheckoutMode;
  }): Promise<PaymentSession>;

  /** A sessão, se ainda estiver aberta; null se expirou/fechou. */
  getPayment(providerRef: string): Promise<PaymentSession | null>;

  /** Best-effort: fecha a sessão de um pedido cancelado. */
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

| Evento do Stripe                          | Vira                            |
| ----------------------------------------- | ------------------------------- |
| `checkout.session.completed` (`paid`)     | `payment.succeeded`             |
| `checkout.session.completed` (`unpaid`)   | `ignored` (método assíncrono)   |
| `checkout.session.async_payment_succeeded`| `payment.succeeded`             |
| `checkout.session.async_payment_failed`   | `payment.failed`                |
| `checkout.session.expired`                | `payment.expired`               |
| `charge.refunded`                         | `payment.refunded`              |
| qualquer outro                            | `ignored`                       |

`orderId` sai de `client_reference_id` (e de `metadata.orderId`, que
também vai em `payment_intent_data` pra que eventos de intent/charge o
carreguem). Eventos de charge são resolvidos por `paymentIntentRef`.

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

Cancelamento:

- [x] Dado um pedido `CREATED` com sessão aberta, quando o cliente
      cancela, então a sessão é expirada no provedor — e o cancelamento
      acontece mesmo se essa chamada falhar.

Configuração e infra:

- [x] Dado nenhum `STRIPE_SECRET_KEY` e `NODE_ENV` diferente de
      `production`, quando o app sobe, então ele sobe com o fake e loga
      aviso, e o checkout continua funcionando ponta a ponta.
- [x] Dado `NODE_ENV=production` sem as variáveis do Stripe, quando o app
      tenta subir, então ele falha no boot.
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
- **Buraco que continua**: as chamadas HTTP ao Stripe (criar sessão,
  reembolsar) não são exercidas por teste automatizado — mesma postura
  honesta do Resend. A verificação manual antes do deploy é o
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
  sessão no `mark-paid` também é uma linha, e entra se incomodar.
- **Ambiente trocado** (evento de test mode chegando no endpoint de
  produção): a assinatura não confere, porque o segredo é por endpoint →
  `400`. Nada especial a fazer.

## Decisões adiadas

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
