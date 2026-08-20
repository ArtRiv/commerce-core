# Spec: e-mails transacionais do pedido

## Status

`in-progress`

Decisões alinhadas antes desta spec, todas registradas aqui porque
nenhuma delas é óbvia a partir do código: quais eventos merecem e-mail,
envio síncrono em vez de fila, idempotência apoiada na contagem de linhas
do `UPDATE` condicional (sem tabela nova), `MailModule` deixando de ser
`@Global`, e o disparo morando dentro do `OrdersService`.

## Objetivo

Fechar o buraco mais visível da v1: hoje o cliente paga e não recebe
absolutamente nada. O módulo `mail` existe desde o `auth`, mas só serve
verificação de e-mail e reset de senha — nenhum evento do ciclo de vida do
pedido produz mensagem. Esta feature liga os dois.

## Escopo

### Entra

- Quatro e-mails, disparados por transição do pedido:
  - **`CREATED → PAID`** — confirmação de compra (o e-mail principal)
  - **`PAID → SHIPPED`** — pedido enviado, com rastreio quando houver
  - **`PAID → REFUNDED`** — reembolso efetuado
  - **`CREATED → CANCELLED`** — **só quando quem cancela não é o dono**
- `MailService` cresce com quatro métodos semânticos, um por e-mail
- `OrderNotificationsService` no módulo `orders`: lê o pedido, monta o
  view model e engole a falha
- Templates puros (`src/mail/order-email-templates.ts`), testáveis sem
  Resend, com escape de HTML e formatação de dinheiro em BRL
- `MailModule` deixa de ser `@Global`; `auth` e `orders` passam a
  importá-lo explicitamente, e o mapa de módulos ganha a seta
  `orders --> mail`

### Não entra (fica pra depois)

- **Fila (BullMQ)** — `claude/context.md` põe fila depois da v1, e é o
  único jeito de ter _retry_. O que fica sem cobertura é exatamente isso:
  crash entre o commit e o envio perde o e-mail. Ver "decisões adiadas".
- **E-mail de `SHIPPED → DELIVERED`** — chega quando a caixa já está na
  mão do cliente. É o mais barato de acrescentar depois: uma linha no
  `deliver`, um template.
- **Cancelamento feito pelo próprio cliente** — ele acabou de receber
  `200` na requisição que ele mesmo disparou; avisar por e-mail o que ele
  acabou de fazer é ruído.
- **Tabela `order_emails`** — ver a invariante de idempotência abaixo.
- **Número de pedido legível** — o e-mail imprime o `uuid`. Feio, mas
  inventar um número curto é coluna nova, sequência nova e decisão de
  formato; não bloqueia o e-mail.
- **Preferências de notificação / opt-out** — e-mail transacional não é
  marketing; opt-out entra junto com o primeiro e-mail que for.
- **Internacionalização** — tudo em pt-BR, como o resto do produto.
- **Texto alternativo (`text/plain`)** — o Resend aceita só HTML e é o
  que o `auth` já faz.

## Regras de negócio / invariantes

- **Falha de e-mail nunca derruba a operação.** Mesma regra que o
  `AuthService.register` já segue (`docs/specs/auth.md`): o envio é
  `try/catch`, logado e engolido. Aqui a regra é mais dura que uma
  preferência de UX — metade destes e-mails nasce do webhook do Stripe, e
  qualquer não-2xx faz o Stripe reentregar o evento. Um Resend fora do ar
  viraria uma tempestade de reentrega de um pagamento que já foi
  aplicado.
- **Envio é síncrono.** Sem fila na v1. A consequência honesta: a
  resposta do webhook espera a latência do Resend. Um provedor _pendurado_
  (não um que falha) segura a entrega do Stripe até o timeout dele — e
  isso converge sozinho, sem e-mail duplicado: o evento fica sem
  `processed_at`, o Stripe reentrega, o `markPaid` bate em `409` e nada é
  enviado de novo.
- **A idempotência é a contagem de linhas do `UPDATE` condicional.**
  Toda transição do `OrdersService` é um `updateMany` condicionado ao
  estado de origem, então `count > 0` é a afirmação verdadeira "isto
  aconteceu agora, nesta chamada". O e-mail sai **depois** desse teste:
  - `markPaid` / `ship` / `deliver` lançam em zero linha → segunda
    chamada não envia nada;
  - `markRefunded` devolve `false` → o webhook `charge.refunded` que
    chega depois da rota `/refund` não manda um segundo e-mail;
  - `cancel` lança em zero linha, dentro da transação.

  Acima disso o `payment_events` já para a reentrega do Stripe antes de
  chegar no domínio, então a proteção é dupla no caminho do webhook.

  **Por que não uma tabela `order_emails`:** ela compraria trilha de
  auditoria e uma base pra um worker de retry — que não existe na v1.
  Gravar linha e completar um `POST` HTTP não são atômicos, então a
  tabela trocaria "talvez zero e-mails" por "talvez dois", que é o pior
  dos dois. Sem worker, ela é um log com migration e RLS.
- **O que o e-mail lê nunca entra na resposta da API.** O
  `OrderNotificationsService` faz a própria leitura, com
  `user: { select: { email, name } }`. Alargar o `ITEMS_INCLUDE` do
  `OrdersService` seria mais curto e estaria errado: mudaria o corpo de
  toda resposta de `GET /orders` e passaria a devolver o e-mail do
  cliente pra qualquer operador que liste pedidos.
- **O e-mail de confirmação quebra o dinheiro em três.** Depois de
  `docs/specs/shipping.md`, `totalCents` é o **valor cobrado**
  (`itemsSubtotalCents + shippingCents`). Um e-mail que imprime só
  `totalCents` não omite o frete — ele **esconde** o frete dentro de um
  número maior que a soma dos itens, e o cliente não fecha a conta. Então
  imprime subtotal, frete (com `shippingMethodName`, e o prazo quando
  houver) e total.
- **Pedido sem frete não renderiza frete.** `shippingMethodCode` nulo é
  a marca de pedido anterior ao módulo de frete (o backfill deixou
  `shippingCents = 0` e método nulo). Nesse caso o e-mail **omite o bloco
  inteiro** — subtotal e frete inclusive — e imprime só o total, que é o
  único número verdadeiro que aquele pedido tem. Nunca
  "Frete: R$ 0,00 — null".
- **Frete grátis é preço zero, não ausência de frete** (regra herdada do
  `shipping`): método preenchido com `shippingCents = 0` imprime
  "Frete: grátis" com o nome do método, e é visivelmente diferente do
  caso acima.
- **Rastreio é opcional e o texto tem que fechar sem ele.** `trackingCode`
  e `trackingUrl` são independentes e ambos anuláveis — uma entrega local
  não tem código. Os quatro casos renderizam: código com link, código sem
  link, só link, e nenhum dos dois (o e-mail continua sendo um aviso
  legítimo de que o pedido saiu).
- **Todo dado que entra no HTML é escapado.** Nome de produto, nome do
  cliente, endereço e código de rastreio são texto livre vindo do banco;
  interpolar direto num template é injeção de HTML no e-mail. Os
  templates do `auth` não precisavam disso (interpolam um token
  url-encoded), estes precisam.
- **`MailModule` deixa de ser `@Global`.** Adota o argumento que
  `payments` e `shipping` já fazem em
  [`docs/architecture/modules.md`](../architecture/modules.md): importar
  o módulo é o que mantém a dependência visível no grafo. Com só o `auth`
  consumindo, a invisibilidade era barata; com `orders` entrando, o mapa
  desenharia duas setas que nenhum código sustenta.
- **O disparo mora dentro do `OrdersService`**, colado em cada transição.
  Não é estética: metade destes e-mails nasce no Stripe, e o webhook já
  passa por `markPaid`/`markRefunded`. Disparar do controller obrigaria a
  duplicar a chamada no `PaymentEventsService`, onde a contagem de linhas
  já foi consumida — um evento reentregue e ainda não carimbado
  reenviaria o e-mail, porque o `409` é capturado lá dentro.
- **O `mail` não conhece o `orders`.** O que cruza a fronteira é um view
  model do módulo `mail` (`OrderEmailData`), montado pelo `orders`.
  A seta continua `orders --> mail`, e trocar o Resend continua sendo
  mudança só dentro de `mail`.

## Superfície da API

Nenhuma rota nova. Os e-mails são efeito das transições que já existem:

| Rota existente                                 | E-mail disparado                                   |
| ---------------------------------------------- | -------------------------------------------------- |
| `POST /orders/:id/mark-paid`                   | confirmação de compra                              |
| `POST /payments/webhook` (`payment.succeeded`) | confirmação de compra                              |
| `POST /orders/:id/ship`                        | pedido enviado                                     |
| `POST /orders/:id/refund`                      | reembolso efetuado                                 |
| `POST /payments/webhook` (`payment.refunded`)  | reembolso efetuado                                 |
| `POST /orders/:id/cancel`                      | cancelamento — **só** se quem cancela não é o dono |

Nenhuma variável de ambiente nova: `RESEND_API_KEY`, `MAIL_FROM` e
`APP_URL` já existem, e `APP_URL` é a base do link "ver seu pedido"
(`/orders/:id` no front, mesmo raciocínio dos links do `auth`).

### Contrato (esboço)

```ts
// src/mail/mail.service.ts — o view model é do mail, montado pelo orders
interface OrderEmailData {
  orderId: string;
  customerName: string | null;
  items: readonly {
    productName: string;
    unitPriceCents: number;
    quantity: number;
  }[];
  itemsSubtotalCents: number;
  /** Null = pedido anterior ao módulo de frete: não renderiza o bloco. */
  freight: {
    cents: number;
    methodName: string;
    etaDays: number | null;
  } | null;
  totalCents: number;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
  };
}

interface OrderShippedEmailData extends OrderEmailData {
  trackingCode: string | null;
  trackingUrl: string | null;
}

interface MailService {
  // ...os dois do auth continuam iguais
  sendOrderPaidEmail(to: string, data: OrderEmailData): Promise<void>;
  sendOrderShippedEmail(to: string, data: OrderShippedEmailData): Promise<void>;
  sendOrderRefundedEmail(to: string, data: OrderEmailData): Promise<void>;
  sendOrderCancelledEmail(to: string, data: OrderEmailData): Promise<void>;
}
```

## Critérios de aceitação

Disparo:

- [ ] Dado um pedido `CREATED`, quando um operator chama `mark-paid`,
      então o cliente recebe o e-mail de confirmação no endereço da
      conta dele.
- [ ] Dado um pedido `CREATED` com sessão de pagamento, quando o webhook
      `payment.succeeded` chega, então o mesmo e-mail é enviado — e
      quando o **mesmo evento** é reentregue, nenhum segundo e-mail sai.
- [ ] Dado um pedido `PAID`, quando `ship` é chamado, então sai o e-mail
      de envio; chamar `ship` de novo → `409` e nenhum e-mail novo.
- [ ] Dado um pedido `PAID`, quando `refund` é chamado, então sai o
      e-mail de reembolso; quando o `charge.refunded` do provedor chega
      depois, nenhum segundo e-mail sai.
- [ ] Dado um pedido `CREATED` de um cliente, quando um **admin**
      cancela, então o cliente é avisado por e-mail; quando o **próprio
      cliente** cancela, nenhum e-mail é enviado.
- [ ] Dado um pedido `SHIPPED`, quando `deliver` é chamado, então
      nenhum e-mail é enviado (fora de escopo, e a ausência é
      deliberada).

Resiliência:

- [ ] Dado um provedor de e-mail fora do ar, quando o pedido é marcado
      como pago, então a transição acontece normalmente (`200`, pedido
      `PAID`) e a falha é só logada — a operação nunca falha por causa do
      e-mail.
- [ ] Dado um provedor de e-mail fora do ar, quando o webhook do Stripe
      entrega `payment.succeeded`, então a resposta é `200` (nada de
      reentrega em massa por causa do Resend) e o pedido está `PAID`.

Conteúdo:

- [ ] Dado um pedido com frete cobrado, quando o e-mail de confirmação é
      montado, então ele carrega subtotal dos itens, frete, nome do
      método e total — e o total é igual a subtotal + frete.
- [ ] Dado um pedido com `shippingMethodCode` nulo (anterior ao frete),
      quando o e-mail é montado, então não há bloco de frete nem
      subtotal: só o total, e em lugar nenhum aparece `null` ou
      "R$ 0,00" de frete.
- [ ] Dado um pedido com frete grátis (método preenchido, zero centavos),
      quando o e-mail é montado, então aparece "grátis" com o nome do
      método — diferente do caso anterior.
- [ ] Dado um envio com código e URL de rastreio, então o e-mail traz o
      código como link; com só o código, traz o código em texto; sem
      nenhum dos dois, o e-mail continua fazendo sentido e não imprime
      rótulo de rastreio vazio.
- [ ] Dado um produto com `<script>` no nome, quando o e-mail é montado,
      então o HTML sai escapado.

## Edge cases conhecidos

- **Crash entre o commit da transição e o envio** → e-mail perdido, e
  nada o reenvia. Consciente: sem fila não existe retry, e a alternativa
  (gravar antes de enviar) produziria duplicata em vez de perda. O
  cliente sempre pode ver o estado do pedido em `GET /orders/:id`.
- **Provedor pendurado no caminho do webhook** → o Stripe estoura o
  timeout e reentrega; converge sem duplicar (ver invariante acima).
- **Pedido marcado como pago à mão** (transferência, Pix) → o e-mail de
  confirmação sai igual. O cliente pagou; por qual trilho é problema
  nosso, não dele.
- **`payment.succeeded` para um pedido que já está `PAID` com OUTRO
  intent** (cobrança dupla real) → `reportUnpayableOrder` continua
  logando o erro e **nenhum** e-mail sai: o cliente já recebeu a
  confirmação, e um segundo "obrigado pela compra" esconderia justo o
  incidente que precisa de humano.
- **Usuário sem `name`** (registro só com e-mail, ou conta Google sem
  nome) → a saudação cai pra uma forma neutra, sem "Olá, null".
- **Reembolso parcial** não existe na v1, então o e-mail afirma o valor
  total do pedido sem ressalva. Se reembolso parcial entrar, este texto
  mente e precisa mudar junto.
- **E-mail do usuário alterado depois da compra** → o e-mail vai pro
  endereço atual da conta, não pra um snapshot no pedido. Correto pra
  v1: não existe troca de e-mail como feature, e o pedido não guarda
  endereço de e-mail.

## Decisões adiadas

- **Fila (BullMQ) + retry** — item 1 do roadmap pós-v1. Quando entrar, o
  `OrderNotificationsService` é o ponto de corte: o `try/catch` vira
  `queue.add`, e nada no `OrdersService` muda.
- **Tabela `order_emails`** — só faz sentido junto com o worker acima.
- **E-mail de `DELIVERED`** e de lembrete de pedido `CREATED` abandonado
  (este depende do job de TTL, já adiado em `docs/specs/orders.md`).
- **Templates de verdade** (MJML/React Email, layout com logo) — hoje é
  HTML inline, como o `auth`. Vira necessidade quando houver identidade
  visual.
- **Cópia pro back-office** ("novo pedido pago") — é outro público e
  outro endereço; sem operação real ainda, seria adivinhação.
