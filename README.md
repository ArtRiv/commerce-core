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

Precisa de **Node >= 22.18 < 23**, **pnpm 10** e um **PostgreSQL** — local,
Docker ou um projeto Supabase novo. Do zero até a API no ar:

```bash
# 1. dependências
pnpm install

# 2. configuração — o .env.example documenta cada variável e por que ela existe
cp .env.example .env
```

Em `development` só duas variáveis são obrigatórias para subir:

| variável | o que é |
| --- | --- |
| `DATABASE_URL` | string de conexão do Postgres |
| `JWT_SECRET` | qualquer string longa e aleatória |

As de Stripe, Resend, frete e proxy podem ficar como estão no exemplo, e as
duas do Google podem ficar vazias — sem elas o login social simplesmente não é
oferecido, e `GET /auth/google` responde 503 em vez de quebrar o boot. **Fora
de `development`/`test` isso muda**: o app se recusa a subir sem chaves reais
de Stripe, sem tabela de frete e sem `TRUST_PROXY_HOPS` — três guardas que
falham no boot com código 1 em vez de degradar em silêncio.

```bash
# 3. esquema do banco
pnpm exec prisma migrate deploy

# 4. dados de referência — catálogo de permissões e os três papéis padrão.
#    Sem isto não existe papel para um usuário novo receber, e o registro falha.
pnpm exec prisma db seed

# 5. opcional: um catálogo de demonstração, para a API responder com algo
pnpm demo:catalog

# 6. sobe em watch mode na :3000
pnpm start:dev
```

Com o app de pé, **<http://localhost:3000/docs>** é a Swagger UI navegável.
Crie a primeira conta em `POST /auth/register`.

Duas coisas que o cadastro não dá, **de propósito**, e que se resolvem no banco
**uma vez**:

```sql
-- verificar o e-mail sem esperar a mensagem (precisa de RESEND_API_KEY real)
update users set email_verified_at = now(), updated_at = now()
where email = 'voce@exemplo.com';

-- promover a PRIMEIRA conta a admin
update users set role_id = (select id from roles where name = 'admin'),
  updated_at = now()
where email = 'voce@exemplo.com';
```

Verificação por rota seria um bypass do e-mail, então essa não tem rota nenhuma
e nunca terá.

O `UPDATE` do papel é diferente: ele é só o **bootstrap**. Depois da primeira
conta admin, quem trabalha na loja se gerencia pela API — `GET /staff` lista a
equipe e acha uma conta pelo e-mail exato, `PATCH /staff/{userId}/role` troca o
papel, e `POST`/`DELETE /staff/{userId}/permissions` concede e revoga uma
permissão avulsa por cima do papel (é assim que um `operator` contratado para
cadastrar peça ganha `products.create` sem virar admin). Tudo atrás de
`staff.manage`, que só o `admin` tem de fábrica e que é ele próprio
concedível — **conceder `staff.manage` é conceder tudo**, porque quem administra
acesso pode pôr uma conta em `admin`. Ver
[`docs/specs/staff-management.md`](docs/specs/staff-management.md).

O primeiro admin continua sendo SQL porque não há a quem pedir: a rota que
concede exige a permissão que ninguém ainda tem.

```bash
# produção
pnpm build
pnpm start:prod
```

## Documentação da API

Com o app no ar, a spec OpenAPI 3 completa — 42 caminhos, 50 operações — fica em:

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

# e2e — precisa de um banco descartável, NÃO o de desenvolvimento
pnpm run e2e:setup    # reconstrói o schema `e2e` do zero
pnpm run test:e2e

# cobertura
pnpm run test:cov
```

A suíte e2e dá `TRUNCATE` nas tabelas do banco para onde o `DATABASE_URL`
aponta. Ela roda contra um **schema separado** (`e2e`), configurado por
`E2E_DATABASE_URL` — ver `.env.example`. Rodar com o `DATABASE_URL` de
desenvolvimento apagaria o catálogo.

## Limitações

O que a v1 deliberadamente **não** tem, para não haver surpresa ao integrar:

- **O primeiro admin ainda é `UPDATE` no banco.** Gestão de acesso agora tem
  rota (`/staff`, atrás de `staff.manage`), mas ela exige a permissão que
  ninguém tem numa instalação nova — então a conta zero é promovida no banco,
  como no passo 6 acima, e daí em diante ninguém mais precisa.
- **Não há convite por e-mail.** As rotas de equipe promovem uma conta que
  **já existe**; criar a conta do funcionário é ele mesmo se registrar.
- **`staff.manage` não é contido.** Quem o tem pode pôr uma conta em `admin`,
  então na prática ele equivale a admin. Está escrito assim de propósito — a
  alternativa seria uma meia-contenção que a troca de papel derruba. Ver a
  invariante 2 de [`docs/specs/staff-management.md`](docs/specs/staff-management.md).
- **Não há ciclo de vida de conta**: suspender, arquivar ou excluir um usuário.
  Suspender de verdade exige recusar no `jwt.strategy` **e** revogar a família
  de refresh tokens; sem as duas metades é um botão que não faz nada por quinze
  minutos. Revogar permissão, esse sim, fecha a porta na requisição seguinte.
- **Não há `/auth/me`.** Nenhuma rota descreve o chamador, e o access token
  carrega só `{ sub }` — um front-end que queira mostrar o nome de quem está
  logado precisa guardá-lo por conta própria no login.
- **Cupons são permissão sem feature**: as quatro permissões `coupons.*`
  existem no catálogo e nenhuma rota as usa ainda.
