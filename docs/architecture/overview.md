# Arquitetura do Sistema — AVESSO Store & Commerce-Core

Este documento descreve a arquitetura técnica, fluxo de dados, estratégias de segurança e integrações entre a vitrine storefront BFF (**`avesso-store`** em Next.js 16) e a API headless de comércio (**`commerce-core`** em NestJS).

---

## 1. Visão Geral do Ecossistema (Macroarquitetura)

O sistema adota uma separação desacoplada entre a camada de apresentação (*Storefront & Back-Office*) e o motor de regras de negócio (*Core API*). O banco de dados PostgreSQL é a única fonte de verdade transacional, e os gateways brasileiros operam por meio de adaptadores modulares.

```mermaid
flowchart TB
    subgraph ClientLayer["1. Camada de Clientes & Navegadores"]
        User["Cliente Final (Storefront Web)"]
        Operator["Lojista / Operador (Painel Admin)"]
    end

    subgraph StorefrontLayer["2. avesso-store (Next.js 16 App Router & BFF)"]
        RSC["React Server Components<br/>(Renderização Server-Side Rápida)"]
        Proxy["Proxy de Sessão<br/>(proxy.ts)"]
        BFF["Rotas API BFF (/api/*)<br/>(Conversão de Cookies em Bearer JWT)"]
        SiteConfig["Central de Identidade Visual<br/>(src/config/site.ts)"]
    end

    subgraph CoreLayer["3. commerce-core (NestJS API Headless)"]
        AuthM["Auth Module<br/>(JWT, Argon2, RBAC, admin:create)"]
        CatalogM["Catalog Module<br/>(Produtos, Categorias, Variantes, Cubagem)"]
        OrdersM["Orders & Cart Module<br/>(Valores em Centavos, Transições)"]
        PayM["Hybrid Payments Router<br/>(Asaas PIX + Mercado Pago)"]
        ShipM["Hybrid Shipping Module<br/>(Melhor Envio + Tabela Offline)"]
        ErpM["ERP Service<br/>(Bling v3 NF-e)"]
        ReportsM["Reports Module<br/>(Métricas Agregadas & Faturamento)"]
    end

    subgraph DataLayer["4. Persistência de Dados"]
        PG[("PostgreSQL<br/>(Supabase / Neon via Prisma 7)")]
    end

    subgraph ExternalServices["5. Provedores Externos & Parceiros"]
        Asaas["Asaas API v3<br/>(PIX Dinâmico + Webhooks)"]
        MP["Mercado Pago API<br/>(Cartão de Crédito até 12x)"]
        MelhorEnvio["Melhor Envio API v2<br/>(Correios, Jadlog, Loggi + Etiquetas)"]
        Bling["Bling ERP API v3<br/>(Sincronização de Pedidos & NF-e)"]
        ViaCEP["BrasilAPI & ViaCEP<br/>(Resolução de Endereço por CEP)"]
        Resend["Resend Mail<br/>(E-mails Transacionais)"]
    end

    User --> Proxy
    Operator --> Proxy
    Proxy --> RSC
    Proxy --> BFF
    RSC -->|Chamadas Server-to-Server| CoreLayer
    BFF -->|Chamadas Autenticadas com JWT| CoreLayer

    CoreLayer --> PG

    PayM --> Asaas
    PayM --> MP
    ShipM --> MelhorEnvio
    ShipM --> ViaCEP
    ErpM --> Bling
    AuthM --> Resend
    OrdersM --> Resend
```

---

## 2. Padrão BFF & Segurança de Sessão (Zero Token no Navegador)

Para mitigar riscos de roubo de credenciais via Cross-Site Scripting (XSS), o navegador **nunca armazena tokens JWT nem acessa segredos de infraestrutura**. O BFF em Next.js mantém os tokens em cookies `httpOnly`, assinados e seguros, convertendo-os em cabeçalhos `Authorization: Bearer <token>` nas chamadas server-to-server contra o `commerce-core`:

```mermaid
sequenceDiagram
    autonumber
    actor Browser as Navegador (Cliente)
    participant BFF as avesso-store (BFF Next.js)
    participant Core as commerce-core (NestJS)
    participant DB as PostgreSQL

    Note over Browser,BFF: 1. Autenticação do Usuário
    Browser->>BFF: POST /api/auth/login (email, password)
    BFF->>Core: POST /auth/login (repasse server-to-server)
    Core->>DB: Busca usuário e valida hash Argon2id
    Core-->>BFF: Retorna { accessToken, refreshToken }
    Note over BFF: Grava accessToken e refreshToken em<br/>Cookies HTTP-Only e Secure
    BFF-->>Browser: HTTP 200 (Set-Cookie: session=...; HttpOnly)

    Note over Browser,BFF: 2. Requisição Protegida (ex: Sacola ou Checkout)
    Browser->>BFF: GET /sacola (envia apenas Cookie httpOnly)
    Note over BFF: Lê o Cookie internamente no servidor<br/>e injeta: Authorization: Bearer <token>
    BFF->>Core: GET /cart (com Authorization Header)
    Core->>Core: Valida assinatura do JWT e RBAC
    Core-->>BFF: Dados protegidos do carrinho
    BFF-->>Browser: HTML renderizado no servidor (RSC)
```

---

## 3. Ciclo de Vida do Pedido & Fluxo de Integrações (Order Lifecycle)

O fluxo de compra e expedição transiciona de ponta a ponta com confirmação assíncrona via webhooks, exportação fiscal desacoplada e compra de frete em 1-clique:

```mermaid
stateDiagram-v2
    [*] --> Catalogo: Cliente seleciona produtos
    Catalogo --> Sacola: Escolhe variante (P/M/G) com peso e cubagem
    Sacola --> Checkout: Informa CEP (preenchimento automático BrasilAPI/ViaCEP)

    state Checkout {
        [*] --> CotacaoFrete: Consulta taxas (Melhor Envio / Tabela offline)
        CotacaoFrete --> EscolhaPagamento: Seleciona PIX ou Cartão 12x
    }

    Checkout --> PedidoCriado: Finaliza pedido (Status: CREATED)

    state PedidoCriado {
        [*] --> PagamentoPIX: Asaas gera QR Code base64 e Copia e Cola
        [*] --> PagamentoCartao: Mercado Pago processa preferência
    }

    PagamentoPIX --> WebhookRecebido: Webhook timing-safe (asaas-access-token)
    PagamentoCartao --> WebhookRecebido: Webhook assinado (HMAC-SHA256)

    WebhookRecebido --> PedidoPago: Status avança para PAID

    state PedidoPago {
        [*] --> ExportacaoBling: BlingErpService exporta pedido para emissão de NF-e
        [*] --> NotificacaoEmail: Resend envia e-mail de confirmação ao comprador
    }

    PedidoPago --> Expedicao: Operador clica em "Comprar Etiqueta" no Admin (/admin/pedidos/id)
    Expedicao --> PedidoDespachado: Status avança para SHIPPED
    
    state PedidoDespachado {
        [*] --> EtiquetaPDF: Grava labelUrl e trackingCode dos Correios/Jadlog
        [*] --> RastreioCliente: Envia código de rastreamento por e-mail
    }

    PedidoDespachado --> [*]: Pedido Entregue (DELIVERED)
```

---

## 4. Estrutura Modular Interna dos Projetos

A arquitetura de código é estruturada por domínios de negócio no NestJS e páginas com componentes orientados a servidor no Next.js:

```mermaid
classDiagram
    class AvessoStore_Next16 {
        +app/ (App Router & Server Components)
        +components/ (StoreLogo, Badge, SiteHeader, SiteFooter)
        +config/ (site.ts - Central de Identidade Visual e Decreto 7.962)
        +lib/api/ (schema.d.ts tipado via OpenAPI)
        +lib/auth/ (cookies httpOnly, sessão)
        +e2e/ (Playwright com navegadores reais)
    }

    class CommerceCore_NestJS {
        +AuthModule (Argon2, JWT, RBAC, admin:create CLI)
        +CatalogModule (Produtos, Categorias, Variantes, Cubagem)
        +OrdersModule (Carrinho, Pedidos, Transições de Status)
        +PaymentsModule (Hybrid Router, Asaas, Mercado Pago)
        +ShippingModule (Hybrid Provider, Melhor Envio, CepService)
        +ErpModule (Bling v3 Service com exportação resiliente)
        +ReportsModule (Agregados financeiros, receita, faturamento)
        +PrismaModule (Conexão tipada com PostgreSQL)
    }

    AvessoStore_Next16 ..> CommerceCore_NestJS: Consome via OpenAPI 3 & BFF
```

---

## 5. Esclarecimento Arquitetural: Caches, Locks e Uso de Redis

### O Redis já está sendo utilizado?
**Não.** Atualmente, o ecossistema opera sem nenhuma dependência de Redis:
- **Cache de CEP:** Armazenado em memória local pelo Node.js com TTL de 24h e política LRU (`CepService`).
- **Rate Limiting:** Controlado em memória pelo NestJS Throttler (`ThrottlerStorageService`).
- **Sessões e Tokens de Atualização:** Persistidos de forma relacional na tabela `refresh_tokens` do PostgreSQL.
- **Carrinhos e Pedidos:** Transacionados diretamente no PostgreSQL com Prisma.

### Por que o Redis foi mencionado no roadmap da Sessão 10?
No planejamento de marketplaces multi-tenant ([`marketplaces_multi_tenant_roadmap.md`](marketplaces_multi_tenant_roadmap.md)), o Redis foi apontado como alternativa para mutex distribuído na rotação de refresh tokens de uso único do Mercado Livre.

> [!NOTE] **Estratégia de Baixo Custo Operacional:**
> Para instâncias de nó único ou clusters moderados, esse lock atômico pode ser executado diretamente no **PostgreSQL** por meio de **PostgreSQL Advisory Locks** (`pg_advisory_xact_lock`) ou `SELECT ... FOR UPDATE`, eliminando a necessidade de gerenciar um servidor Redis adicional e reduzindo os custos de hospedagem a praticamente zero. O Redis permanece como adaptador opcional para quando a infraestrutura exigir escala horizontal em múltiplos nós.
