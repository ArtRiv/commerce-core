# commerce-core

Backend headless de e-commerce: um único core de API que qualquer
front-end (loja, app mobile, painel admin) pode consumir.

Projeto de portfólio. Segunda tentativa em cima de um e-commerce anterior
(Next.js + NestJS + PostgreSQL + Stripe) que não chegou a ser finalizado
nem deployado — desta vez com escopo mais restrito e foco em entregar uma
v1 pequena, testada e em produção antes de expandir.

## Stack

- [NestJS](https://nestjs.com/) (TypeScript)
- PostgreSQL (Supabase), via [Prisma](https://www.prisma.io/) 7
- Stripe, via interface própria `PaymentProvider`
- [Resend](https://resend.com/) para e-mail transacional
- Deploy: Render (Docker, free tier) — ver [`docs/deploy.md`](docs/deploy.md)

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

## Documentação da API

Com o app no ar, a spec OpenAPI 3 completa das 38 rotas fica em:

- **`/docs`** — Swagger UI, navegável, com "Authorize" pro bearer token
- **`/docs-json`** — o documento cru

Pra gerar o `openapi.json` da raiz (é ele que o front-end usa pra
codegen de cliente) sem subir servidor, banco ou chave de API nenhuma:

```bash
pnpm run openapi:generate
```

O documento é gerado a partir dos decorators, então ele não é editado à
mão — e um teste (`src/openapi/document.spec.ts`) falha se uma rota nova
não aparecer nele, ou se o que ele diz sobre autenticação divergir do que
os guards fazem. Ver [`docs/specs/openapi.md`](docs/specs/openapi.md).

## Deploy

Render (Docker, uma instância no free tier) contra um projeto Supabase
**separado** do de desenvolvimento — a suíte e2e dá `TRUNCATE` nas
tabelas do banco pra onde aponta, então dividir os dois seria perder a
loja num `pnpm test:e2e` distraído.

O procedimento (banco, blueprint, webhook do Stripe, verificação) está em
[`docs/deploy.md`](docs/deploy.md); o porquê de cada escolha, incluindo
os trade-offs aceitos do free tier, em
[`docs/specs/deploy.md`](docs/specs/deploy.md).

Fora de `development`/`test` o app **se recusa a subir** sem chaves reais
de Stripe, sem tabela de frete e sem `TRUST_PROXY_HOPS` — três guardas
que falham no boot com código 1 em vez de degradar em silêncio. As
variáveis estão documentadas em [`.env.example`](.env.example).

## Testes

```bash
# unitários
pnpm run test

# e2e
pnpm run test:e2e

# cobertura
pnpm run test:cov
```
