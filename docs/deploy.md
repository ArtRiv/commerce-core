# Runbook: colocar no ar e manter

O _porquê_ de cada escolha está em [`specs/deploy.md`](specs/deploy.md).
Aqui é só o procedimento.

Topologia: **Render** (free, uma instância, Docker) → **Supabase**
(projeto de produção, separado do de desenvolvimento) → **Stripe** (test
mode) e **Resend** (`fel.tec.br`).

---

## 1. Banco de produção (uma vez)

Produção **não** pode dividir banco com o desenvolvimento: a suíte e2e
roda `TRUNCATE` em `users`, `products`, `categories`, `orders`, `carts` e
`payment_events`. Um `pnpm test:e2e` distraído apagaria a loja.

1. No Supabase, criar um **projeto novo**, região `us-east-1` (a mesma
   ponta do Render `virginia`).
2. Copiar a connection string em **Connect → Session pooler**, não a
   "Direct connection". O host direto (`db.<ref>.supabase.co`) não
   publica registro A — só IPv6 — e é inalcançável de qualquer
   plataforma sem egress IPv6. O host do pooler
   (`aws-N-<região>.pooler.supabase.com`) resolve pra IPv4.
3. Guardar como `DATABASE_URL` — é o valor que o Render vai pedir.

As migrations **não** precisam ser rodadas à mão: o entrypoint do
container roda `prisma migrate deploy` antes de subir o app.

## 2. Serviço no Render (uma vez)

1. **New → Blueprint**, apontando pro repositório. O Render lê
   [`render.yaml`](../render.yaml) e cria o web service já configurado
   (Docker, plano free, região `virginia`, health check em `/`,
   auto-deploy só quando o CI passa).
2. O Render vai pedir os valores marcados `sync: false`:

   | Variável                | Valor                                                      |
   | ----------------------- | ---------------------------------------------------------- |
   | `DATABASE_URL`          | o pooler do passo 1                                         |
   | `RESEND_API_KEY`        | a chave existente                                           |
   | `STRIPE_SECRET_KEY`     | `sk_test_…`                                                 |
   | `STRIPE_WEBHOOK_SECRET` | **deixar em branco por ora** — sai do passo 3               |
   | `API_URL`               | `https://commerce-core.onrender.com` (a URL deste serviço)  |
   | `APP_URL`               | a origem do frontend                                        |

   `JWT_SECRET` é gerado pelo Render (`generateValue`) e não é digitado
   por ninguém. `NODE_ENV`, `TRUST_PROXY_HOPS`, `MAIL_FROM`,
   `SHIPPING_TABLE` e as duas de Stripe não-secretas já vêm do
   `render.yaml`.

   `API_URL` é circular — a URL só existe depois do serviço criado. Criar
   com um valor qualquer e corrigir depois do primeiro deploy funciona;
   só o callback do Google OAuth depende dela, e ele é opcional.

3. O primeiro deploy vai **falhar no boot** por falta de
   `STRIPE_WEBHOOK_SECRET`, e isso é o comportamento correto (a guarda de
   pagamentos). Passo 3 resolve.

## 3. Webhook do Stripe (uma vez)

O segredo de assinatura é **por endpoint**: o `whsec_` que o
`stripe listen` imprime localmente não vale pro endpoint do Render.

1. No dashboard do Stripe (test mode) → **Developers → Webhooks → Add
   endpoint**.
2. URL: `https://<serviço>.onrender.com/payments/webhook`
3. Eventos — exatamente os cinco que o app trata
   ([`specs/payments.md`](specs/payments.md)):
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
4. Copiar o **Signing secret** (`whsec_…`) e colar em
   `STRIPE_WEBHOOK_SECRET` no Render. Salvar dispara um novo deploy, que
   agora sobe.

## 4. Catálogo de demonstração (uma vez, opcional)

Roda da máquina, apontando pro banco de produção — não roda no deploy,
de propósito (um deploy que reescreve produtos é um bug, não uma
feature).

```sh
DATABASE_URL="<pooler de produção>" pnpm demo:catalog
```

Todos os produtos vêm com `weightGrams` real. Produto sem peso cota em
`SHIPPING_DEFAULT_WEIGHT_GRAMS` (500 g) e a loja come a diferença no que
for mais pesado.

## 5. Verificar

```sh
BASE=https://<serviço>.onrender.com

curl -s $BASE/            # {"status":"ok","version":"1.0.0","uptimeSeconds":N}
curl -s $BASE/products    # o catálogo
open $BASE/docs           # Swagger
```

E a compra de verdade, que é o único teste que importa: registrar um
usuário, verificar o e-mail, montar carrinho, cotar frete, fazer
checkout, pagar com `4242 4242 4242 4242` na página do Stripe e conferir
que o pedido virou `PAID`. Os critérios estão em
[`specs/deploy.md`](specs/deploy.md#critérios-de-aceitação).

---

## Operação

### O serviço hiberna

Free tier do Render dorme após 15 min sem tráfego e leva ~1 min pra
acordar. Consequência real: um webhook do Stripe que chega com o app
dormindo **expira** (o Stripe corta em 30s) e só confirma na
retentativa — o pedido fica `CREATED` nesse meio tempo e converge
sozinho depois. Nada se perde; a experiência é que fica ruim.

Mitigação de custo zero: um monitor externo (UptimeRobot, intervalo de 5
min) batendo em `GET /`. A cota free é de 750 horas/mês e um mês tem
~730, então manter **um** serviço acordado o tempo todo cabe — dois não.

### Rodar uma migration nova

Nada a fazer: `prisma migrate deploy` roda no start do container. Basta
o merge na `main` (com o CI verde, por causa do `autoDeployTrigger:
checksPass`).

Cuidado com migration **destrutiva**: o banco migra antes do app novo
servir tráfego, então por alguns segundos o código antigo fala com o
schema novo. Todas as migrations até hoje são aditivas. A primeira que
não for tem que virar duas (expand, depois contract).

### Trocar um segredo

Dashboard do Render → Environment. Salvar redeploya. `JWT_SECRET` é o
único cuja troca desloga todo mundo (os access tokens em circulação
deixam de verificar) — os refresh tokens sobrevivem, porque são hash no
banco.

### Quando existir uma segunda instância

O rate limiting é **em memória, por instância**
(`src/app.module.ts`). O plano free não escala além de uma, então hoje
está correto por construção. No minuto em que houver duas, os limites de
[`security.md`](security.md) passam a valer por instância e viram
ficção — trocar pelo storage Redis do `@nestjs/throttler` antes, não
depois.

### Google OAuth (opcional)

`GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` não estão no `render.yaml`. Sem
eles o app sobe e `/auth/google` responde 503. Pra ligar: registrar
`${API_URL}/auth/google/callback` no console do Google — a URI tem que
bater exatamente — e adicionar as duas variáveis no dashboard.
