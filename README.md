# commerce-core

Backend headless de e-commerce: um único core de API que qualquer
front-end (loja, app mobile, painel admin) pode consumir.

Projeto de portfólio. Segunda tentativa em cima de um e-commerce anterior
(Next.js + NestJS + PostgreSQL + Stripe) que não chegou a ser finalizado
nem deployado — desta vez com escopo mais restrito e foco em entregar uma
v1 pequena, testada e em produção antes de expandir.

## Stack

- [NestJS](https://nestjs.com/) (TypeScript)
- PostgreSQL
- ORM: a definir (Prisma ou TypeORM)
- Stripe, via interface própria `PaymentProvider`
- Deploy: a definir (Railway, Render ou Fly.io)

## Escopo da v1

- Auth & autorização (JWT, refresh token, RBAC)
- Catálogo & estoque
- Carrinho & pedidos (criado → pago → enviado → entregue)
- Pagamentos (Stripe) & frete, atrás de interfaces próprias
- Documentação OpenAPI/Swagger
- Testes unitários + e2e
- CI (lint + testes + build)
- Deploy real — critério de sucesso da v1

Mais detalhes de escopo, convenções e roadmap em [`claude/context.md`](claude/context.md).
Arquitetura (diagramas Mermaid) e o workflow de spec + TDD ficam em [`docs/`](docs/).

## Rodando o projeto

```bash
pnpm install
```

```bash
# desenvolvimento (watch mode)
pnpm run start:dev

# produção
pnpm run start:prod
```

## Testes

```bash
# unitários
pnpm run test

# e2e
pnpm run test:e2e

# cobertura
pnpm run test:cov
```
