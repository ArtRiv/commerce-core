# Visão de contexto

> Status: desenho-alvo. Só o esqueleto do NestJS existe até agora — nenhum
> módulo de domínio foi implementado ainda. Atualize este diagrama assim
> que a realidade divergir dele.

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
    shipping["Provedor de frete"]

    store --> core
    mobile --> core
    admin --> core
    core --> db
    core --> stripe
    core --> shipping
```

## Decisões que aparecem neste diagrama

- **Um único core, múltiplos consumidores**: nenhum front-end tem lógica
  de domínio própria; tudo passa pela API.
- **Stripe e frete ficam atrás de interfaces próprias** (`PaymentProvider`,
  `ShippingProvider`) — o core depende de uma abstração, não do SDK do
  Stripe diretamente. Ver [`architecture/modules.md`](modules.md).
- Sem multi-tenancy, sem microsserviços na v1 (ver `claude/context.md`
  para o que fica fora de escopo).
