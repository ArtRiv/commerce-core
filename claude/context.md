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

Por restrição de tempo, o Claude **implementa os módulos** — escreve a
implementação completa, os testes e os docs. O modo anterior ("eu escrevo
o corpo, você só sugere o esqueleto") foi abandonado; não tenho tempo pra
codar isto à mão agora, então a ajuda do Claude é a forma de tocar o
projeto. Ainda assim:

- Seguir sempre o [`docs/workflow.md`](../docs/workflow.md): spec antes do
  código, TDD unitário, e2e como rede de segurança. Disciplina de entrega
  continua valendo — implementar não é pular etapa.
- Antes de implementar um módulo, alinhar comigo a **spec** e as decisões
  de arquitetura (modelo de dados, superfície da API, trade-offs). Eu
  reviso e aprovo o desenho; o Claude escreve.
- Quando houver duas abordagens razoáveis, apontar as duas com um
  trade-off honesto e uma recomendação — não uma pesquisa exaustiva.
- Perguntas de arquitetura e revisão crítica do que já existe são sempre
  bem-vindas.

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

## Modelo de reuso: um repositório, N implantações

Este projeto não é o backend de **uma** loja — é o backend que eu
pretendo reusar toda vez que fizer um e-commerce novo. Cada loja é uma
**implantação própria** da mesma `main`: banco próprio, conta Stripe
própria, domínio de e-mail próprio. Nenhuma sabe que as outras existem.
O passo a passo está em [`../docs/new-store.md`](../docs/new-store.md).

Isso **não** é a multi-tenancy que está fora de escopo abaixo. Aquilo é
uma instância servindo várias lojas, com `storeId` em toda tabela e em
toda query — onde um `WHERE` esquecido vaza pedido de uma loja na outra.
Aqui o isolamento é físico e sai de graça.

**A regra que mantém isso vivo — e é a única que importa:**

> Nunca forkar. Toda loja implanta a `main` deste repositório. Se uma
> loja precisa de algo que o commerce-core não tem, isso vira um PR
> **aqui**, e a próxima loja já nasce com aquilo. Diferença entre lojas
> só existe em **configuração**.

O primeiro `if (loja === 'x')` no código é o momento em que isto deixa de
ser um template e vira dois projetos que divergem até nenhum dos dois
ser reusável. Template não morre de arquitetura ruim, morre de disciplina.

Corolário prático: generalidade não se inventa antes da hora. Feature
entra quando uma loja real precisa dela, não porque "alguma loja um dia
pode querer".

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
- Padrões de segurança (senha, tokens, rate limiting) seguem OWASP e
  estão registrados em [`docs/security.md`](../docs/security.md) —
  qualquer spec nova que lide com credencial ou dado sensível segue
  esse documento em vez de redecidir do zero.
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
