# Contexto do projeto — backend modular de e-commerce

## O que é este projeto

Um backend headless de e-commerce: um único core de API que qualquer
front-end (loja, app mobile, painel admin) pode consumir. Projeto de
portfólio, com foco em terminar e fazer deploy de uma v1 pequena antes
de expandir escopo.

Vem de um e-commerce anterior (Next.js + NestJS + PostgreSQL + Stripe)
que não chegou a ser finalizado nem deployado. Esta é uma segunda
tentativa, com escopo mais restrito e mais disciplina de entrega.

## Como eu quero trabalhar com o Claude Code neste projeto

Isto é importante: o objetivo principal aqui é **aprender e desenvolver
músculo próprio**, não terceirizar o código para IA. Portanto:

- Não escreva a implementação completa de módulos/features a não ser
  que eu peça explicitamente ("implementa isso pra mim"). Por padrão,
  prefira: explicar o trade-off, sugerir a interface/esqueleto, ou
  apontar o padrão a seguir — e deixar eu escrever o corpo.
- Quando eu pedir pra "ler a documentação de X e resumir", foque em
  resumo prático e direto, não em me convencer de uma abordagem.
- Quando eu estiver decidindo entre duas abordagens, apresente os dois
  lados (prós/contras) em vez de decidir por mim.
- Sinta-se à vontade para revisar código que eu já escrevi e apontar
  problemas, más práticas, ou sugestões de refino.
- Perguntas de arquitetura são bem-vindas a qualquer momento — é
  exatamente o tipo de ajuda que eu quero.

## Escopo da v1 (o que ENTRA)

- Auth & autorização: JWT, refresh token, RBAC (roles: cliente,
  operador, admin)
- Catálogo & estoque: produtos, categorias, controle simples de estoque
- Pedidos & carrinho: criação de carrinho, checkout, ciclo de vida do
  pedido (criado → pago → enviado → entregue)
- Pagamentos & frete: integração com Stripe e com pelo menos um
  provedor de frete, escondidos atrás de uma interface própria
  (`PaymentProvider`, `ShippingProvider`) para permitir troca de
  provedor sem reescrever o domínio
- Documentação da API via OpenAPI/Swagger (gerado pelo NestJS)
- Testes: unitários no domínio + e2e nos endpoints principais
- CI simples: lint + testes + build no GitHub Actions
- Deploy real (Railway, Render ou Fly.io) — este é o critério de
  sucesso da v1, não é opcional

## Fora do escopo da v1 (fica para depois)

- Multi-tenancy (múltiplas lojas isoladas na mesma instância)
- Split em microsserviços — v1 é um monólito modular
- Motor de busca dedicado (Elasticsearch/Meilisearch)
- Fila de background jobs (BullMQ + Redis) — entra assim que a v1
  básica estiver no ar, para webhooks e e-mails transacionais
- Webhooks/eventos de domínio para consumidores externos

## Stack

- NestJS (TypeScript)
- PostgreSQL
- ORM: a definir (Prisma ou TypeORM — discutir prós/contras antes de
  fixar)
- Stripe (via `PaymentProvider`)
- Deploy: a definir (Railway/Render/Fly.io)

## Estrutura de pastas sugerida (ponto de partida, não regra fixa)

```
src/
  auth/            # login, JWT, guards, roles
  catalog/         # produtos, categorias, estoque
  orders/          # carrinho, pedidos, ciclo de vida
  payments/        # PaymentProvider + StripeAdapter
  shipping/        # ShippingProvider + adapter concreto
  common/          # filtros, pipes, decorators compartilhados
  config/          # configuração de ambiente
```

## Convenções

- Workflow de feature: spec em `docs/specs/` antes do código, TDD
  inside-out (unit-first) no domínio, e2e depois como rede de
  segurança. Detalhado em [`docs/workflow.md`](../docs/workflow.md).
- Commits: conventional commits (`feat:`, `fix:`, `refactor:`, etc.)
- Branches: `feature/nome-curto`, merge via PR mesmo trabalhando sozinho
  (prática de portfólio)
- Cada módulo do Nest deve ser fechado em si mesmo (controller,
  service, module, dto, entity) — evitar acoplamento cruzado direto
  entre módulos; comunicação entre módulos passa por interfaces claras

## Roadmap pós-v1

1. Fila de jobs (BullMQ + Redis) para e-mails e webhooks do Stripe
2. Webhooks/eventos de domínio (`order.created`, `payment.confirmed`)
3. Observabilidade básica (logs estruturados, health-check)
4. Multi-tenancy
5. Busca dedicada
