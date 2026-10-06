# commerce-core

Backend para sistemas de e-commerce com arquitetura headless, cobrindo autenticação e autorização RBAC, catálogo com suporte a variantes, pedidos, pagamentos híbridos, cálculo de frete e integrações com ERP e logística.

## Stack

- [NestJS](https://nestjs.com/) (TypeScript)
- PostgreSQL via [Prisma](https://www.prisma.io/) 7
- Pagamentos: Asaas (Pix dinâmico com QR Code e webhooks) e Mercado Pago (Cartão de crédito) via interface `PaymentProvider`
- Frete e Logística: Melhor Envio e cálculo por faixas de CEP com consulta ViaCEP / BrasilAPI via interface `ShippingProvider`
- ERP Fiscal: Bling v3 (sincronização de pedidos e geração de etiquetas)
- E-mail transacional: [Resend](https://resend.com/)
- Testes unitários (Jest) e testes de carga (k6)
- Docker

## Rodando o projeto

Requisitos: Node >= 22.18, pnpm 10 e PostgreSQL.

```bash
# 1. Dependências
pnpm install

# 2. Configuração de ambiente
cp .env.example .env
```

Em desenvolvimento, apenas duas variáveis são obrigatórias para inicializar o servidor:

| Variável | Descrição |
| --- | --- |
| `DATABASE_URL` | String de conexão do PostgreSQL |
| `JWT_SECRET` | Segredo para assinatura de tokens JWT |

```bash
# 3. Executar migrations e seed de permissões e papéis
pnpm exec prisma migrate deploy
pnpm exec prisma db seed

# 4. Criar o primeiro usuário administrador
pnpm run admin:create -- --email admin@exemplo.com --name "Administrador" --password "SenhaForte123!"
# Ou execute interativamente:
# pnpm run admin:create

# 5. Opcional: carregar catálogo de demonstração
pnpm demo:catalog

# 6. Iniciar em modo de desenvolvimento
pnpm start:dev
```

A API estará disponível em `http://localhost:3000`.

Para criar contas de clientes comuns, utilize o endpoint `POST /auth/register`.

```bash
# Build e execução em produção
pnpm build
pnpm start:prod
```

## Documentação da API

- **Swagger UI**: `http://localhost:3000/docs`
- **OpenAPI JSON**: `http://localhost:3000/docs-json`

Para regenerar a especificação `openapi.json` a partir dos decorators do código:

```bash
pnpm run openapi:generate
```

## Testes

```bash
# Testes unitários
pnpm run test

# Testes de cobertura
pnpm run test:cov

# Testes de carga (k6)
pnpm run test:load
```

## Arquitetura

Diagramas de arquitetura, fluxo de checkout, ciclo de vida do pedido e registros de decisões técnicas estão documentados em [`docs/architecture/overview.md`](docs/architecture/overview.md).
