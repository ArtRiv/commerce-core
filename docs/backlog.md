# Backlog — pedidos vindos de uma loja real

Coisas que uma loja construída sobre o commerce-core pediu e que **ainda não
foram decididas**. Não é lista de desejo: cada entrada aqui nasceu de uma tela
concreta que alguém estava construindo.

Isto é o complemento de [`known-issues.md`](known-issues.md), que é só para o
que está *errado*. Aqui está o que falta, e o "adiado" de cada spec continua
sendo o registro do que já foi decidido a favor de não fazer.

Formato: o que a loja precisou, o que o backend tem hoje, por que não foi feito
na hora, e um esboço do que fazer.

---

## payments: modo de checkout como configuração de loja, e a chave publicável

**Quem pediu**: a AVESSO (`avesso-store`), construindo o `/checkout`
(2026-08-27).

**O que a loja precisou**: renderizar o formulário da Stripe dentro da própria
página — o modo `embedded`, que o artboard do design assume.

**O que existe hoje**: `STRIPE_CHECKOUT_MODE` já escolhe `hosted` ou `embedded`
por implantação, e `CheckoutDto.paymentMode` deixa o cliente insistir num modo.
Do lado do pagamento, portanto, está resolvido.

**O que falta**: a **chave publicável**. O commerce-core guarda
`STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET` e nada mais — não há variável nem
rota que entregue a `pk_...` ao navegador. Sem ela `loadStripe()` não sobe, e
portanto **nenhum front-end consegue montar o `embedded`**, mesmo recebendo o
`clientSecret` que `POST /orders` já devolve. Hoje o modo existe na API e é
inalcançável na prática.

**Por que não foi feito na hora**: a AVESSO roda `hosted` e não precisa disso.
Abrir PR para o modo que ela não usa seria generalidade antes da hora. E a
saída fácil — cada front-end guardar `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` no
próprio `.env` — é justamente a que não se quer: a chave publicável e a secreta
são do mesmo par, e guardá-las em repositórios diferentes é convidar uma loja a
rodar com a `pk_` de uma conta e a `sk_` de outra.

**Esboço**: `STRIPE_PUBLISHABLE_KEY` no `.env` do serviço, e uma rota pública de
configuração — algo como `GET /config` devolvendo o que o navegador da loja
precisa saber sobre esta instância, começando por
`{ paymentMode, paymentPublishableKey }`. `paymentMode` junto porque hoje o
front-end também não tem como perguntar em que modo a instância está: ele
descobre pela forma do `payment` que volta, depois de o pedido já existir.

A rota também é o lugar natural para o pedido maior do dono do projeto: **uma
loja nova deveria se configurar por um arquivo declarado, não por adivinhação**
— `EMBEDDED_CHECKOUT=true` e afins, num só lugar, lido por quem sobe a loja e
publicado para quem a consome. Isso é maior que uma rota e não está desenhado.

---

## shipping/orders: endereço estruturado (número e bairro)

**Quem pediu**: a AVESSO (`avesso-store`), construindo o `/checkout`
(2026-08-27).

**O que a loja precisou**: os quatro campos que o design desenha, que são os
que qualquer brasileiro espera preencher — `Endereço`, `Número`, `Bairro`,
`Cidade / UF`.

**O que existe hoje**: `ShippingAddressDto` é
`line1 / line2? / city / state / postalCode`, e o pedido guarda o mesmo como
snapshot (`shippingLine1`, `shippingLine2`, …). O número entra dentro de
`line1` — que é como o exemplo do próprio spec o escreve, `Rua das Flores, 100`
— e o bairro não tem onde entrar.

**Por que não foi feito na hora**: nada se perde hoje. O CEP determina o
bairro, a etiqueta sai com cidade e UF, e o frete é cotado só do CEP de
qualquer forma. A loja seguiu com quatro campos honestos em vez de inventar
dois que a API não tem, e registrou a divergência.

**Por que ainda assim vale**: passa nas três perguntas do teste de decisão sem
esforço — toda loja brasileira quer, é dado persistido, e não há como resolver
do lado do front-end sem serializar um endereço dentro de um campo de texto. E
o dia em que uma transportadora de verdade entrar no lugar da `SHIPPING_TABLE`,
ela vai querer o número separado.

**Esboço**: migration acrescentando `number` e `neighborhood` (ambos nullable,
porque os pedidos que já existem não os têm) ao snapshot do pedido, mais os
campos correspondentes no `ShippingAddressDto`. É mudança de contrato numa
rota que já está em uso, então o caminho compatível é aceitar os novos campos
como opcionais e manter `line1` como está, em vez de quebrar quem já manda o
número dentro dele.

**Junto disso, e separado**: não existe consulta de CEP → endereço. O design da
AVESSO mostra o endereço preenchido depois do `Calcular frete`, e
`POST /shipping/quote` devolve opções de frete e mais nada. Uma integração de
CEP é a mesma conversa (toda loja brasileira quer) e tem a mesma resposta: se
entrar, entra aqui, não em cada front-end.
