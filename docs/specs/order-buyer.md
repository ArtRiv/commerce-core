# Spec: order-buyer (quem comprou, na resposta do pedido)

## Status

`draft`

## Objetivo

Um pedido diz `userId` e mais nada sobre quem comprou. Qualquer back-office
que liste pedidos precisa mostrar **nome e e-mail** do comprador, e hoje não
existe rota nenhuma que traduza aquele UUID — `customers.read` está no
catálogo de permissões sem nada atrás. Esta spec expõe o comprador **dentro do
pedido**, para quem já pode ler o pedido dos outros.

Não é uma rota de clientes. É o campo que faltava numa resposta que já existe.

## Escopo

### Entra

- `OrderResponse.buyer` — `{ id, name, email }`, ou `null`
- Preenchido **somente** para um chamador que carrega `orders.read`; `null`
  para todos os outros, inclusive o próprio dono do pedido
- Vale para as duas leituras (`GET /orders`, `GET /orders/{id}`) e para as
  cinco transições de back-office, que respondem `OrderResponse` e alimentam
  a mesma tela

### Não entra (fica pra depois)

- **Rota de clientes** (`GET /customers`, `GET /customers/{id}`). É o item 2
  de [`../admin-api.md`](../admin-api.md) e continua valendo por si
- **Endereço, telefone ou histórico do comprador.** O pedido já carrega o
  endereço de entrega congelado; o resto é a rota de clientes
- **Filtro ou busca por nome/e-mail** em `GET /orders`. `userId` continua
  sendo o único filtro por pessoa
- **Auditoria de quem leu.** Item 6 do mesmo documento

## Regras de negócio / invariantes

1. **`buyer` nunca carrega campo de `User` que não seja `id`, `name` ou
   `email`.** O `select` do Prisma nomeia os três explicitamente e a classe de
   resposta declara os três. Nenhum spread, nenhum `select *`, nenhum
   `include: { user: true }` — `User` carrega `passwordHash` e `googleId`, e o
   caminho barato para vazá-los é justamente o genérico
   ([`../admin-api.md`](../admin-api.md), item 2).

2. **`buyer` é `null` sem `orders.read`.** Não ausente: o campo existe sempre
   no contrato, e o que varia é o valor. Um campo que às vezes some obriga
   todo cliente tipado a tratar `undefined` além de `null`, e o OpenAPI
   descreveria mal as duas formas.

3. **A permissão é `orders.read`, não `customers.read`.** Decisão registrada,
   não descuido: quem pode ler o pedido de qualquer pessoa já lê o endereço de
   entrega dela, que identifica mais do que um nome. Nome e e-mail *daquele
   pedido* são dado do pedido — a nota fiscal os carrega. `customers.read`
   continua reservada para o diretório de clientes, que lista gente sem pedido
   nenhum e é outra superfície.

4. **`name` é anulável.** `User.name` é `String?` — uma conta criada pelo
   Google pode nunca ter passado por `RegisterDto`. `buyer.name` é
   `string | null` e quem exibe decide o *fallback*.

5. **A visibilidade não muda o escopo da consulta.** Continua valendo que sem
   `orders.read` a consulta não enxerga pedido alheio, e que pedido de outro é
   404 e não 403. Este campo não abre porta nenhuma: ele só nomeia o
   comprador de um pedido que o chamador já podia ler.

6. **O webhook não tem chamador.** `markPaid` e `markRefunded` também são
   chamados pelo processador de pagamento, onde não existe usuário
   autenticado. Nesse caminho `buyer` é `null` — e a resposta do webhook nem é
   um pedido, então nada em tela depende disso.

## Superfície da API

Nenhuma rota nova. Um campo novo em `OrderResponse`, que já é o corpo de:

| Método | Rota | Descrição | Auth |
| ------ | ---- | --------- | ---- |
| GET | `/orders` | lista (itens de `PaginatedOrdersResponse`) | bearer |
| GET | `/orders/{id}` | um pedido | bearer |
| POST | `/orders/{id}/cancel` | `CREATED → CANCELLED` | bearer |
| POST | `/orders/{id}/mark-paid` | `CREATED → PAID` | `orders.update_status` |
| POST | `/orders/{id}/ship` | `PAID → SHIPPED` | `orders.update_status` |
| POST | `/orders/{id}/deliver` | `SHIPPED → DELIVERED` | `orders.update_status` |
| POST | `/orders/{id}/refund` | `PAID → REFUNDED` | `orders.refund` |

`POST /orders` (checkout) e `POST /orders/{id}/pay` respondem
`OrderWithPaymentResponse`, que estende `OrderResponse` — herdam o campo, e na
prática ele vem `null`, porque quem faz checkout é o comprador.

### DTOs (esboço)

```ts
export class OrderBuyerResponse {
  id: string;
  /** Null numa conta criada pelo Google, que nunca passou por RegisterDto. */
  name: string | null;
  email: string;
}

export class OrderResponse {
  // ...tudo o que já existe
  /** Null para quem não carrega orders.read. */
  buyer: OrderBuyerResponse | null;
}
```

## Critérios de aceitação

- [ ] Dado um chamador com `orders.read`, quando lê `GET /orders/{id}` de
      outra pessoa, então `buyer` traz `id`, `name` e `email` do comprador
- [ ] Dado um chamador com `orders.read`, quando lista `GET /orders`, então
      **todo** item traz seu próprio `buyer`
- [ ] Dado um cliente comum, quando lê o próprio pedido, então `buyer` é
      `null` — e o pedido continua respondendo tudo o mais
- [ ] Dado um cliente comum, quando lista os próprios pedidos, então nenhum
      item traz `buyer`
- [ ] Dado qualquer chamador, quando a resposta é montada, então ela **não**
      contém `passwordHash`, `googleId`, `emailVerifiedAt`, `roleId` nem
      qualquer outro campo de `User`
- [ ] Dado um comprador sem nome (conta do Google), quando um operador lê o
      pedido, então `buyer.name` é `null` e `buyer.email` está preenchido
- [ ] Dado um operador com `orders.update_status`, quando chama
      `POST /orders/{id}/ship`, então a resposta traz `buyer` se ele também
      tiver `orders.read`, e `null` se não tiver
- [ ] Dado o webhook do processador, quando ele move um pedido para `PAID`,
      então nada quebra por não haver chamador

## Edge cases conhecidos

- **Operador com `orders.update_status` e sem `orders.read`.** Existe: as
  permissões são independentes e a checagem é por permissão, nunca por role.
  Ele move o pedido e recebe `buyer: null`. É o comportamento certo — a regra
  é uma só e não tem exceção por rota.
- **O comprador lendo o próprio pedido.** Recebe `null` sobre si mesmo, o que
  parece estranho e é deliberado: ele não precisa da API para saber o próprio
  nome, e alargar a resposta para o caso que não usa é como um campo vira
  hábito.
- **Custo da consulta.** Um `include` a mais numa listagem de até 100 pedidos
  é um segundo `SELECT` do Prisma sobre `users.id`, que é chave primária. Sem
  N+1.
- **Pedido de usuário apagado.** Não acontece hoje: a FK de `Order.user` é
  `Restrict` e apagar conta não é feature. Se um dia for, esta spec passa a
  ter uma pergunta.

## Decisões adiadas

- **Sempre popular `buyer`, inclusive para o dono.** Simplificaria o código e
  o contrato. Fica de fora porque o pedido para esta mudança veio do painel, e
  alargar a resposta do storefront de tabela junto não tem gatilho.
- **`buyer` em `CartResponse`.** O carrinho é sempre do próprio chamador. Não
  há caso.
