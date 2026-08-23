# Subindo uma loja nova

commerce-core é **um repositório, N implantações**. Cada loja é uma
instância própria, com banco próprio, conta Stripe própria e domínio de
e-mail próprio — nenhuma sabe que as outras existem. O código é o mesmo
em todas; o que muda é só configuração.

Este documento é o passo a passo de uma loja nova, do zero até uma compra
de teste funcionando. Reserve ~1 hora, e a maior parte é esperar
verificação de DNS.

O _porquê_ deste modelo (e por que não multi-tenancy) está em
[`../claude/context.md`](../claude/context.md). A operação do dia a dia
está em [`deploy.md`](deploy.md).

---

## 0. Antes de começar: o que é por loja e o que é compartilhado

| | Por loja | Compartilhado |
| --- | --- | --- |
| Código | — | o repositório `commerce-core` |
| Banco Postgres | projeto Supabase próprio | — |
| Pagamento | conta Stripe própria | — |
| E-mail | domínio verificado no Resend | a conta Resend pode ser a mesma |
| Serviço | web service próprio no Render | — |
| Tabela de frete, moeda, remetente | valores próprios | o formato |

**Regra que sustenta o modelo:** nunca fork. Toda loja implanta a
`main` deste repositório. Se uma loja precisa de algo que o
commerce-core não tem, isso vira um PR **aqui** — e aí toda loja futura
já nasce com aquilo. Um `if (loja === 'x')` no código é o fim do
template.

## 1. Contas a criar

Faça as três primeiras em paralelo; a verificação de domínio do Resend é
a que demora.

### Supabase — o banco

1. Projeto **novo** (não reaproveite o de outra loja nem o de
   desenvolvimento).
2. Região: `us-east-1`, para casar com a região `virginia` do Render.
3. Guarde a senha do banco quando ela for exibida — ela só aparece uma
   vez.
4. Em **Connect**, copie a string do **Session pooler**:

   ```
   postgresql://postgres.<ref>:<senha>@aws-N-us-east-1.pooler.supabase.com:5432/postgres
   ```

   Tem que ser o **pooler**, não a "Direct connection": o host direto
   (`db.<ref>.supabase.co`) não publica registro A, só IPv6, e o Render
   não tem egress IPv6. E porta **5432** (session), não 6543
   (transaction) — migration precisa de sessão.

### Stripe — o pagamento

Conta **por loja**, porque o dinheiro cai numa conta bancária por loja.

1. Crie a conta e fique em **test mode** enquanto desenvolve.
2. Em **Developers → API keys**, copie a chave secreta (`sk_test_…`).
3. O **webhook** só dá pra criar depois que o serviço existir — passo 4.
4. Para cobrar de verdade depois, a conta precisa completar o onboarding
   (`charges_enabled`). Test mode funciona antes disso; live mode não.

### Resend — o e-mail

A conta pode ser a mesma entre lojas; o **domínio** é por loja.

1. **Domains → Add domain**, com o domínio da loja.
2. Publique os registros DNS que o Resend mostrar (SPF/DKIM). Espere
   ficar `verified` — pode levar de minutos a horas.
3. `MAIL_FROM` sai daí: `Nome da Loja <nao-responda@dominio-da-loja>`.

> **A armadilha que não avisa.** Sem domínio verificado, o remetente
> sandbox `onboarding@resend.dev` só entrega para o e-mail dono da conta
> Resend. Todo e-mail de pedido de todo cliente vai silenciosamente para
> lugar nenhum, e **nada** no app reporta problema. Não suba loja com o
> remetente sandbox.

### Render — o serviço

Conta única serve para várias lojas; cada loja é um web service.

## 2. Criar o serviço

**New → Blueprint**, apontando para `ArtRiv/commerce-core`. O Render lê
o [`render.yaml`](../render.yaml) e cria o serviço já configurado:
Docker, plano free, região `virginia`, health check em `/`, deploy
automático só quando o CI passa.

Ele vai pedir os valores marcados `sync: false`:

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | o pooler do passo 1 |
| `RESEND_API_KEY` | a chave da conta Resend |
| `STRIPE_SECRET_KEY` | `sk_test_…` desta loja |
| `STRIPE_WEBHOOK_SECRET` | **deixe em branco** — sai do passo 4 |
| `API_URL` | a URL deste serviço (veja abaixo) |
| `APP_URL` | a origem do front-end desta loja |

`JWT_SECRET` é gerado pelo Render e ninguém digita.

`API_URL` é circular: a URL só existe depois do serviço criado, e o
Render sufixa o nome se ele já estiver em uso
(`commerce-core-kvlg.onrender.com`). Ponha qualquer coisa, e corrija
assim que a URL aparecer.

**O primeiro deploy vai falhar no boot**, por falta de
`STRIPE_WEBHOOK_SECRET`. Isso é a guarda de pagamentos funcionando, não
um erro.

### Ajustar o que é desta loja

No `render.yaml` os valores não-secretos são literais — servem de default
mas quase sempre mudam por loja. Ajuste **no dashboard** (não no
arquivo, que é compartilhado):

- `SHIPPING_TABLE` — a tabela de frete desta loja. Formato e regras de
  validação em [`.env.example`](../.env.example) e
  [`specs/shipping.md`](specs/shipping.md). Tabela inválida derruba o
  boot nomeando a opção culpada.
- `MAIL_FROM` — o remetente desta loja, no domínio verificado dela.
- `SHIPPING_FREE_ABOVE_CENTS` — opcional; em branco significa sem frete
  grátis, que **não** é a mesma coisa que `0`.

## 3. Migrations e dados iniciais

Nada a fazer: o entrypoint do container roda `prisma migrate deploy` e o
seed de roles/permissions a cada start. Um `DATABASE_URL` errado
**reprova o deploy** em vez de virar um serviço verde que dá 500.

Catálogo de demonstração, se quiser algo para olhar (roda da sua
máquina, uma vez):

```sh
DATABASE_URL="<pooler desta loja>" pnpm demo:catalog
```

## 4. Webhook do Stripe

O segredo de assinatura é **por endpoint** — o `whsec_` do
`stripe listen` local não vale aqui.

1. Stripe (test mode) → **Developers → Webhooks → Add endpoint**
2. URL: `https://<serviço>.onrender.com/payments/webhook`
3. Os cinco eventos que o app trata:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
4. Copie o **Signing secret** e cole em `STRIPE_WEBHOOK_SECRET` no
   Render. Salvar dispara um deploy, que agora sobe.

## 5. Verificar

```sh
BASE=https://<serviço>.onrender.com
curl -s $BASE/          # {"status":"ok",...}
curl -s $BASE/products  # o catálogo
open $BASE/docs         # Swagger
```

Depois, a compra de verdade — é o único teste que importa: registrar,
verificar e-mail, montar carrinho, cotar frete, fechar pedido, pagar com
`4242 4242 4242 4242` e conferir que o pedido virou `PAID`. Critérios
completos em [`specs/deploy.md`](specs/deploy.md).

## 6. Um admin de verdade

O seed cria os **roles** (`customer`, `operator`, `admin`), não usuários.
Todo mundo que se registra nasce `customer`. Para ter back-office,
promova alguém direto no banco depois de registrar:

```sql
UPDATE users
   SET role_id = (SELECT id FROM roles WHERE name = 'admin')
 WHERE email = 'voce@dominio-da-loja';
```

## 7. Custo por loja

| | |
| --- | --- |
| Render free | R$ 0 — **hiberna** após 15 min sem tráfego, ~1 min para acordar |
| Render Starter | ~US$ 7/mês — sem hibernação |
| Supabase free | R$ 0 — 1 projeto por loja, com limites |
| Stripe | por transação |
| Resend free | 3.000 e-mails/mês |
| Domínio | por loja, por ano |

**Free só serve para demonstração.** Um webhook do Stripe que chega com
o serviço dormindo expira em 30s e só confirma na retentativa — o pedido
fica `CREATED` alguns minutos. Não se perde nada, mas nenhum cliente de
verdade merece isso. Loja com cliente real começa no plano pago.

## Checklist

- [ ] Projeto Supabase novo, `us-east-1`, string do **Session pooler**
- [ ] Conta Stripe da loja, `sk_test_…` copiada
- [ ] Domínio **verificado** no Resend
- [ ] Blueprint criado no Render, segredos preenchidos
- [ ] `SHIPPING_TABLE` e `MAIL_FROM` ajustados para esta loja
- [ ] Endpoint de webhook criado, `STRIPE_WEBHOOK_SECRET` preenchido
- [ ] `API_URL` corrigida para a URL real
- [ ] `GET /` responde, `/docs` abre
- [ ] Uma compra de teste chegou a `PAID` e o e-mail foi entregue
- [ ] Um usuário promovido a `admin`
