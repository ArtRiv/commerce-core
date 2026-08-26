# Integrando um front-end com o commerce-core

Escrito para quem — pessoa ou agente — vai construir uma loja **em outro
repositório** consumindo esta API.

> **Este arquivo é feito para ser copiado.** Leve-o para o repositório do
> front-end (por exemplo em `docs/backend-commerce-core.md`) e referencie
> no `CLAUDE.md` de lá. Ele é autocontido de propósito: quem o lê não
> tem o código do backend à mão.

---

## O que o commerce-core é

Um backend **headless** de e-commerce: uma API REST e nada mais. Não
serve HTML, não tem sessão, não tem cookie, não renderiza página
nenhuma. Autenticação é `Authorization: Bearer <token>`.

Ele resolve: contas e permissões, catálogo e estoque, carrinho, pedidos e
seu ciclo de vida, pagamento via Stripe, cotação de frete e os e-mails
transacionais do pedido.

Ele **não** resolve, e o front-end precisa: qualquer tela, o layout do
checkout, as páginas que recebem os links enviados por e-mail, e o painel
administrativo.

Uma instância serve **uma loja**. Outra loja é outra implantação, com
outro banco e outra conta Stripe.

## Comece pelo contrato, não por este texto

O repositório do backend publica um documento OpenAPI 3 com as **38
rotas**, e ele é conferido pelo CI a cada PR — não envelhece em silêncio.

- `GET /docs` — Swagger navegável, com "Authorize" para colar um token
- `GET /docs-json` — o documento cru
- `openapi.json` na raiz do repositório do backend

**Gere o cliente a partir dele.** Não escreva tipos à mão: eles vão
divergir, e o documento é a única fonte que o CI garante.

## As seis coisas que quebram quem não sabe

1. **Dinheiro é `Int` em centavos, sempre.** `priceCents`, `totalCents`,
   `shippingCents`. Nunca float. Uma moeda por instância (BRL); o pedido
   não tem coluna de moeda. Formate na exibição, nunca no armazenamento.
2. **O webhook é a verdade sobre o pagamento, não o redirect.** Quando o
   comprador volta da página do Stripe, o pedido **pode ainda estar
   `CREATED`** — quem o move para `PAID` é o webhook que o Stripe manda
   para o servidor, e ele pode chegar depois. A tela de sucesso tem que
   reconsultar `GET /orders/:id` até ver `PAID`, não assumir.
3. **Autenticação é ligada por padrão.** Um guard global protege tudo; as
   rotas públicas optam por sair. Rota nova nasce privada.
4. **O access token dura 15 minutos.** Roles e permissões são resolvidas
   do banco a cada requisição, então permissão revogada é revogada agora,
   não em quinze minutos.
5. **O refresh token é de uso único.** Cada `POST /auth/refresh` devolve
   um par novo e aposenta o apresentado. Reapresentar um já gasto é
   tratado como **roubo** e revoga a família inteira da sessão — o
   usuário é deslogado. Consequência prática: **nunca dispare dois
   refresh concorrentes com o mesmo token.** Serialize numa única
   promise compartilhada.
6. **CEP é obrigatório e validado.** `postalCode` no formato
   `80000-000` (com ou sem hífen). O frete sai só do CEP; cidade e
   estado são para o rótulo da etiqueta.

## `APP_URL` e `API_URL` são coisas diferentes

- `API_URL` — a origem **desta API**. É dela que sai o callback do Google
  OAuth.
- `APP_URL` — a origem do **front-end**. É para lá que apontam os links
  de verificação de e-mail e de redefinição de senha, e as URLs de
  retorno do Stripe.

Ou seja: **o back-end manda e-mails com links para páginas que o
front-end precisa implementar.** No mínimo duas:

| Rota no front-end | O que faz |
| --- | --- |
| `/verify-email?token=…` | lê o token da query e chama `POST /auth/verify-email` |
| `/reset-password?token=…` | lê o token e chama `POST /auth/reset-password` |

Sem elas, o cadastro não se completa: **verificação de e-mail é
obrigatória para login por senha**.

## Fluxo de conta

```
POST /auth/register            -> 201, e-mail de verificação enviado
   (usuário clica no link)
POST /auth/verify-email        -> 204
POST /auth/login               -> 200 { accessToken, refreshToken }
POST /auth/refresh             -> 200 { accessToken, refreshToken }  (rotativo, uso único)
POST /auth/logout              -> revoga a sessão
```

Esqueceu a senha: `POST /auth/forgot-password` (responde **igual**
existindo a conta ou não — é anti-enumeração; não tente inferir nada da
resposta) e depois `POST /auth/reset-password`.

Google: `GET /auth/google` inicia; responde `503` se a instância não tiver
as credenciais configuradas. Trate esse `503` como "esconda o botão", não
como erro.

## Fluxo de compra

```
GET  /products                     catálogo público
POST /cart/items                   { productId, quantity }
GET  /cart                         o carrinho é do TOKEN — não há id de carrinho em URL nenhuma
                                   -> { items, itemsSubtotalCents, itemCount }
POST /shipping/quote               { postalCode }
                                   -> { options: [...], itemsSubtotalCents }
POST /orders                       { shippingAddress, shippingOptionCode, quotedShippingCents }
                                   -> 201 { id, status: 'CREATED', payment: {...} }
```

Uma opção de frete é
`{ code, label, priceCents, estimatedDays, carrier, orderTotalCents }`.
`estimatedDays` e `carrier` podem ser `null`.

No checkout você devolve `shippingOptionCode` e `quotedShippingCents` da
opção escolhida. **O servidor re-cota** e recusa se não bater — o preço
não vem do cliente.

### Não some dinheiro no navegador

Os três totais vêm prontos, e é de propósito
([`specs/cart-totals.md`](specs/cart-totals.md)):

- `itemsSubtotalCents` no carrinho — soma de `priceCents × quantity` sobre
  o **preço vivo** do catálogo. Carrinho vazio é `0`, nunca `null`.
- `itemCount` no carrinho — soma das quantidades, pro badge. Duas
  camisetas e uma calça são `3`, não `2`.
- `orderTotalCents` em **cada opção** de frete — `itemsSubtotalCents` mais
  o `priceCents` daquela opção. É o valor exato que o `POST /orders` vai
  cobrar: dá pra escrever "Finalizar pedido — R$ 522,30" no botão antes de
  existir pedido nenhum, e o `totalCents` do pedido criado bate com ele.

`GET /cart` **não** traz total do pedido, e isso não é esquecimento: sem
CEP não há frete, e um "total" sem frete é justamente o número que um
checkout não pode exibir.

### Pagar

`payment` na resposta do checkout é
`{ mode, url, clientSecret, expiresAt }` e pode ser **`null`** quando o
provedor estava fora do ar. Isso não é erro: o pedido nasceu, o estoque
foi reservado, e o caminho de recuperação é `POST /orders/:id/pay`.

- `mode: 'hosted'` — mande o comprador para `payment.url` (página do
  Stripe).
- `mode: 'embedded'` — monte o formulário do Stripe na sua página com
  `payment.clientSecret`.

Nos dois casos os campos de cartão são do Stripe, nunca seus. É isso que
mantém o escopo de PCI em SAQ-A.

Depois do pagamento, veja o ponto 2 acima: **reconsulte o pedido**.

### Ciclo de vida do pedido

```
CREATED ──pago──> PAID ──> SHIPPED ──> DELIVERED
   │                │
   └──> CANCELLED   └──> REFUNDED
```

`POST /orders/:id/cancel` é do cliente. `ship`, `deliver`, `mark-paid` e
`refund` são de back-office e exigem permissão.

## Convenção de erros

| | |
| --- | --- |
| `400` | corpo inválido (a validação rejeita campo desconhecido, não ignora) |
| `401` | sem token, token expirado ou inválido |
| `403` | autenticado, mas sem a permissão exigida |
| `404` | não existe **ou** não é seu (pedido de outro cliente dá 404, não 403) |
| `409` | conflito de estado: estoque insuficiente, transição inválida, pedido já pago |
| `429` | rate limit; respeite o header `Retry-After` |
| `503` | provedor externo fora do ar (`/pay`), ou recurso desligado nesta instância |

`409` é o mais interessante para a UI: é o que aparece quando o último
item acabou entre a montagem do carrinho e o checkout. Tem que ter uma
mensagem de verdade.

## Autorização

Rotas de back-office exigem uma **permissão**, nunca uma role. As roles
(`customer`, `operator`, `admin`) são linhas no banco que mapeiam para um
conjunto de permissões, então redefinir o que `admin` significa não muda
rota nenhuma.

Permissões existentes: `products.read|create|update|delete`,
`orders.read|update_status|cancel|refund`, `customers.read`,
`coupons.read|create|update|delete`, `reports.read`.

Quem se registra nasce `customer`. Promover a `admin` é um `UPDATE` no
banco (ver o runbook de loja nova do backend).

As permissões de `coupons` existem no catálogo e **não têm feature
atrás** — reservadas de propósito. Não construa UI de cupom esperando
endpoint.

## O que ainda não existe

Não assuma nenhuma destas:

- **Variantes de produto** (tamanho, cor, SKU). Um produto tem um preço e
  um estoque. É a primeira coisa que uma loja real vai pedir, e é
  mudança de schema no backend.
- **Cupons e descontos.**
- **Carrinho de convidado** — precisa estar logado para ter carrinho.
- **Busca e filtro ricos** no catálogo.
- **Upload de imagem** — `imageUrls` são URLs que você hospeda em outro
  lugar.
- **Webhooks de domínio** para consumidores externos.

Se o front-end precisar de uma delas, o caminho é um **PR no
commerce-core** — não um contorno no front-end. É assim que a próxima
loja já nasce com aquilo.

## Rodando contra a API em desenvolvimento

Você não precisa rodar o backend para começar: aponte para a instância
publicada, gere o cliente do `/docs-json` dela e construa contra ela.

Se precisar rodar local (`http://localhost:3000`), o repositório do
backend traz o passo a passo; o resumo é `pnpm install`, um `.env` a
partir de `.env.example` e `pnpm start:dev`. Sem chave do Stripe ele sobe
com um provedor falso e o checkout funciona ponta a ponta — de propósito,
para que um clone novo consiga desenvolver sem conta de pagamento.

**Cuidado com plano free:** a instância publicada hiberna após 15 min sem
tráfego e leva ~1 min para acordar. A primeira requisição depois de um
tempo parado vai parecer travada. Não é bug, e não vale construir
_workaround_ no front-end.

## Se você é um agente construindo o front-end

Ordem de leitura recomendada:

1. Este arquivo, inteiro.
2. `GET /docs-json` da instância que vai usar — é o contrato real, e
   ganha deste texto em qualquer divergência.
3. Gere o cliente tipado a partir dele antes de escrever a primeira tela.

Regras que valem para todo o trabalho:

- Nunca escreva tipos de request/response à mão.
- Nunca trate o retorno do Stripe como confirmação de pagamento.
- Nunca dispare dois refresh concorrentes.
- Nunca invente endpoint: se não está no documento OpenAPI, não existe, e
  a solução é um PR no backend.
- Trate `409` e `429` como estados de UI de primeira classe, não como
  erro genérico.
