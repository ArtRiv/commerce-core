# Status — o que existe hoje

Retrato do projeto no fim da v1 (2026-08-23). Serve pra duas coisas:
saber o que já está pronto sem reler sete specs, e ser o ponto de partida
de quem for **consumir** esta API (o front-end é um projeto separado).

Para o _porquê_ de cada decisão, as specs em [`specs/`](specs/) continuam
sendo a fonte. Aqui é só o retrato.

---

## No ar

| | |
| --- | --- |
| API | <https://commerce-core-kvlg.onrender.com> |
| Documentação navegável | [`/docs`](https://commerce-core-kvlg.onrender.com/docs) |
| Documento OpenAPI cru | [`/docs-json`](https://commerce-core-kvlg.onrender.com/docs-json) |
| Liveness | `GET /` |
| Banco | Supabase (projeto de **produção**, separado do de desenvolvimento) |
| Pagamento | Stripe em **test mode** |
| E-mail | Resend, domínio `fel.tec.br` verificado |
| Plano | Render free, **uma instância** |

Uma compra real (test mode) já passou ponta a ponta pelo webhook
publicado: pedido `PAID`, `paidAt`, `paymentIntentRef`, evento gravado em
`payment_events` e e-mail de confirmação entregue. Procedimento e
operação em [`deploy.md`](deploy.md).

**Free tier**: o serviço hiberna após 15 min sem tráfego e leva ~1 min pra
acordar. Um webhook que chega com ele dormindo falha na primeira entrega
e converge na retentativa do Stripe. Detalhe e mitigação em
[`specs/deploy.md`](specs/deploy.md).

## O que a v1 entrega

Tudo o que `claude/context.md` listou como escopo da v1, incluindo o
critério de sucesso (deploy real).

| Módulo | O que faz | Spec |
| --- | --- | --- |
| `auth` | Registro, verificação de e-mail, login (senha e Google), refresh rotativo de uso único, reset de senha, RBAC por permissão | [auth](specs/auth.md) |
| `catalog` | Produtos, categorias, **variantes** (tamanho) com estoque próprio, ciclo `DRAFT → ACTIVE → ARCHIVED` | [catalog](specs/catalog.md), [product-variants](specs/product-variants.md) |
| `orders` | Carrinho **por variante** com totais prontos, checkout, ciclo `CREATED → PAID → SHIPPED → DELIVERED` mais `CANCELLED`/`REFUNDED` | [orders](specs/orders.md), [cart-totals](specs/cart-totals.md) |
| `payments` | Stripe atrás de `PaymentProvider`: Checkout Session (hosted/embedded), webhook assinado, reembolso | [payments](specs/payments.md) |
| `shipping` | Frete atrás de `ShippingProvider`: tabela por prefixo de CEP e faixa de peso | [shipping](specs/shipping.md) |
| `mail` | Quatro e-mails transacionais do pedido, atrás de `MailService` | [order-emails](specs/order-emails.md) |
| `openapi` | Documento gerado dos decorators, commitado e conferido pelo CI | [openapi](specs/openapi.md) |

Números: **39 rotas** em 8 controllers, **468 testes unitários**,
**189 e2e**, 11 migrations.

### Autorização

Três roles (`customer`, `operator`, `admin`) que são **linhas no banco**
mapeando para um conjunto de permissões — as rotas de back-office exigem
a **permissão**, nunca a role, então redefinir o que `admin` significa não
mexe em nenhuma rota. Catálogo em `src/auth/authz/permissions.ts`:

`products.read|create|update|delete`, `orders.read|update_status|cancel|refund`,
`customers.read`, `coupons.read|create|update|delete`, `reports.read`.

As de `coupons` existem no catálogo e **não têm feature atrás** — reservadas
de propósito.

## Fora do escopo da v1, de propósito

Multi-tenancy, microsserviços, motor de busca dedicado, fila de background
jobs (BullMQ), webhooks de domínio pra consumidores externos. Mais: carrinho
de convidado, TTL de reserva de estoque, cupons. O raciocínio de cada um
está nas "decisões adiadas" da spec correspondente e no fim de
[`../claude/handoffs.md`](../claude/handoffs.md).

## Para quem vai consumir esta API

1. **Gere o cliente do `openapi.json`** commitado na raiz, não escreva
   tipos à mão. Ele é conferido pelo CI (`git diff --exit-code` depois de
   regerar), então não envelhece em silêncio.
2. **Autenticação é por padrão.** Um guard global protege tudo; as rotas
   públicas optam por sair (`@Public`). Access token dura 15 min e carrega
   só o `sub`; roles e permissões são resolvidas do banco a cada
   requisição, então permissão revogada é revogada agora.
3. **Refresh token é de uso único.** Reapresentar um já gasto é tratado
   como roubo e revoga a família inteira da sessão — o cliente nunca pode
   disparar dois refresh concorrentes com o mesmo token.
4. **`APP_URL` é o front-end, `API_URL` é esta API.** Links de verificação
   e reset, e as URLs de retorno do Stripe, apontam para o **front-end** —
   são páginas que você precisa implementar. Hoje `APP_URL` é um
   placeholder e esses links vão dar 404 num browser.
5. **Fluxo de compra**: `POST /cart/items` (com `variantId` — a unidade
   vendável é o **tamanho**, ver
   [`specs/product-variants.md`](specs/product-variants.md)) →
   `POST /shipping/quote` →
   `POST /orders` (com `shippingOptionCode` e `quotedShippingCents`, que o
   servidor re-cota) → o cliente paga em `payment.url` (hosted) ou monta o
   formulário com `payment.clientSecret` (embedded) → o **webhook** move o
   pedido para `PAID`, não o retorno do browser.
6. **Dinheiro é sempre `Int` em centavos.** Nunca float. Uma moeda por
   instância (`STRIPE_CURRENCY`); o pedido não tem coluna de moeda. E os
   totais vêm prontos — subtotal e contagem no carrinho, total do pedido por
   opção de frete ([`specs/cart-totals.md`](specs/cart-totals.md)).

## Buracos conhecidos

Registrados, não esquecidos — [`known-issues.md`](known-issues.md) tem o
detalhe e o esboço de correção de cada um:

- Carrinho não tem teto cumulativo por item.
- Identificadores do Stripe (`cs_`, `pi_`, `re_`) saem em toda leitura de
  pedido, sem consumidor.
- O parser da tabela de frete ignora chaves que não conhece — foi assim
  que `etaDays` ficou anos documentado no lugar de `estimatedDays`.
- As linhas do carrinho voltam ordenadas por um UUID: estável, mas sem
  significado nenhum pra quem lê.

Fora esses, o item de operação mais importante: o **rate limiting é em
memória, por instância**. Com uma instância está correto por construção;
na segunda vira ficção e precisa do storage Redis do `@nestjs/throttler`
**antes**, não depois.
