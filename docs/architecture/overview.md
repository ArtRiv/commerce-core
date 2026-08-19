# Visão de contexto

> Status: real. `auth`, `catalog`, `orders`, `payments` e `shipping`
> existem, e a seta pro Stripe é código — inclusive na volta, que o
> diagrama não mostra: o Stripe chama `POST /payments/webhook` de volta
> pra confirmar pagamento e reembolso. O provedor de frete da v1 é uma
> tabela por faixa de CEP configurada por ambiente, então a seta pra fora
> ainda **não** sai da máquina: ela existe como interface
> (`ShippingProvider`), pronta pra uma transportadora real entrar atrás
> dela. Atualize este diagrama assim que a realidade divergir dele.

`commerce-core` é o único core de API que qualquer front-end (loja, app
mobile, painel admin) consome. Ele não serve HTML nem tem UI própria.

```mermaid
flowchart TB
    subgraph clients["Front-ends (fora deste repo)"]
        store["Loja (storefront)"]
        mobile["App mobile"]
        admin["Painel admin"]
    end

    core[["commerce-core API<br/>(NestJS)"]]

    db[("PostgreSQL")]
    stripe["Stripe"]
    shipping["Provedor de frete<br/>(tabela local na v1)"]

    store --> core
    mobile --> core
    admin --> core
    core --> db
    core --> stripe
    core -.-> shipping
```

## Decisões que aparecem neste diagrama

- **Um único core, múltiplos consumidores**: nenhum front-end tem lógica
  de domínio própria; tudo passa pela API.
- **Stripe e frete ficam atrás de interfaces próprias** (`PaymentProvider`,
  `ShippingProvider`) — o core depende de uma abstração, não do SDK do
  Stripe diretamente. Ver [`architecture/modules.md`](modules.md). A seta do
  frete é tracejada porque na v1 o provedor é local (tabela por faixa de
  CEP): a abstração já existe, a chamada externa ainda não.
- Sem multi-tenancy, sem microsserviços na v1 (ver `claude/context.md`
  para o que fica fora de escopo).
