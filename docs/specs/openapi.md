# Spec: documentação da API (OpenAPI/Swagger)

## Status

`in-progress`

Último item de escopo da v1 antes do deploy (`claude/context.md`:
"Documentação da API via OpenAPI/Swagger (gerado pelo NestJS)"). Ao
contrário dos outros módulos, este não tem domínio próprio: não cria
tabela, não cria rota de negócio, não muda comportamento. O que ele
entrega é um **contrato publicado** das 38 rotas que já existem.

A motivação imediata é o frontend, que vai ser um projeto separado
consumindo esta API — sem spec publicada, o contrato vive na cabeça de
quem escreveu o backend, e o frontend descobre cada campo por tentativa.

## Objetivo

Publicar um documento OpenAPI 3.1 completo e honesto das 38 rotas da v1
— com autenticação, **permissão exigida**, e as respostas de erro que
cada rota realmente produz — e mantê-lo incapaz de divergir do código
sem que um teste quebre.

## Escopo

### Entra

- `@nestjs/swagger` instalado e o documento montado no bootstrap
- Swagger UI em `/docs`, e o JSON cru em `/docs-json`
- Script `openapi:generate` que escreve `openapi.json` na raiz sem subir
  servidor — é o artefato que o frontend consome pra codegen
- Bearer auth declarado, e aplicado em toda rota que o guard global
  protege (ou seja: todas menos as `@Public()`)
- **A permissão exigida por rota**, visível no documento — ver "Regras"
- Respostas de erro por rota, seguindo a convenção que as specs já
  fixaram (`400/401/403/404/409/429/503`)
- Classes de resposta (`*Response`) pros objetos de domínio que um
  consumidor modela, **usadas como tipo de retorno do controller** — ver
  "Regras"
- O webhook documentado como o que é: corpo opaco, autenticado por
  assinatura, sem DTO
- `GET /` promovido de placeholder do scaffold pra health check de
  verdade — ver "Regras"
- Um teste que falha quando o documento gerado não cobre uma rota

### Não entra (fica pra depois)

- **Boundary de serialização em runtime** (`ClassSerializerInterceptor`
  + `@Exclude`/`@Expose`). É a decisão adiada mais importante desta
  spec, registrada em "Decisões adiadas" com o motivo.
- Exemplos de request/response por rota (`@ApiResponse({ examples })`) —
  o esquema basta pra codegen; exemplo bom exige dado realista e é
  trabalho de outra passada
- Versionamento da API (`/v1/...`) — a v1 é a única que existe; prefixo
  de versão é migration de rota, decisão própria
- Cliente TypeScript gerado e publicado — o `openapi.json` é o insumo; o
  codegen roda no projeto do frontend, não aqui
- Documentar rotas que não existem ainda (health check profundo, métricas)

## Regras de negócio / invariantes

Este módulo não tem regra de negócio — tem regras sobre o **documento**.

- **A permissão é o dado interessante, e não é descobrível.** Um
  consumidor olhando `POST /orders/:id/refund` vê que precisa de token;
  não tem como saber que precisa de `orders.refund` especificamente, nem
  que só `admin` tem essa permissão. Logo: a permissão **entra no
  documento**, na descrição da resposta `403`.

  E entra pelo mesmo lugar que a impõe. `@RequirePermissions(...)` passa
  a emitir, além do metadado que o `PermissionsGuard` lê, o
  `@ApiBearerAuth()` e as respostas `401`/`403` — com os nomes das
  permissões interpolados na descrição do `403`. **Não existe um segundo
  lugar pra manter em sincronia**: se a rota muda de permissão, a
  documentação muda junto porque é a mesma chamada de decorator. Um
  `@ApiOperation` escrito à mão dizendo "requer orders.refund" seria
  exatamente a duplicação que envelhece.

- **O documento tem que concordar com o guard, e é um teste que garante
  isso.** O `JwtAuthGuard` é global com opt-out por `@Public()`, então a
  verdade sobre "esta rota exige token" já existe num lugar só: o
  metadado `IS_PUBLIC_KEY`. O documento declara o bearer rota a rota (via
  os decorators compostos abaixo), e um teste varre os controllers,
  compara o metadado do guard com o `security` de cada operação e falha
  nas **duas** direções — rota protegida sem bearer no documento, e rota
  `@Public()` declarando um.

  A alternativa — `addSecurityRequirements` global no `DocumentBuilder`
  com as rotas `@Public()` limpando — foi descartada na implementação:
  limpar exige `security: []` no nível da operação, o único caminho pra
  isso é `@ApiOperation`, e o `@ApiOperation` do `@nestjs/swagger`
  reinjeta `summary: ''` a cada aplicação. Duas aplicações no mesmo
  handler (a do `@Public()` e a que escreve o resumo) apagariam o resumo
  dependendo da ordem dos decorators — um bug silencioso e sensível a
  formatação. O teste dá a mesma garantia sem depender de ordem.

- **`@Public()` não quer dizer "anônimo".** Três rotas públicas são
  auth-aware: `GET /products` e `GET /products/:idOrSlug` usam o
  `OptionalJwtAuthGuard` (token opcional que **amplia** o que se
  enxerga), e `POST /payments/webhook` é autenticado por assinatura.
  OpenAPI não tem como dizer "bearer opcional", então isso é dito na
  descrição da operação — em texto, porque é o único lugar onde cabe.

- **Erro documentado é erro que a rota produz.** As specs já fixaram a
  convenção (`orders.md`, `payments.md`, `shipping.md` cada uma repete
  a sua): `400` input malformado; `401` sem token; `403` sem permissão;
  `404` inexistente **ou de outro dono**; `409` conflito com o estado;
  `429` rate limit; `503` provedor indisponível. `401` e `403` saem do
  decorator de permissão; os outros são anotados onde a spec diz que
  acontecem — não em bloco, porque `409` numa rota de leitura seria
  mentira e `404` num `POST /auth/login` também.

- **`503` está em seis rotas, não em uma.** Levantado na auditoria desta
  spec: `POST /orders` (provedor de frete fora — a falha aborta o
  checkout de propósito), `POST /orders/:id/pay` (provedor de pagamento
  fora), `POST /shipping/quote` (idem frete), `GET /auth/google` e
  `GET /auth/google/callback` (Google não configurado) e
  `POST /payments/webhook` (reembolso chegando antes do pagamento —
  `503` deliberado, é o que faz o Stripe reentregar). Cada um já estava
  specado no seu módulo; o que faltava era alguém olhar os seis juntos.

- **O webhook não ganha DTO, e o documento não inventa um.** O corpo é
  bytes crus verificados por assinatura (`main.ts` sobe com
  `rawBody: true`); a `ValidationPipe` global nem o vê, porque não há
  classe dizendo o que esperar. Documentar um schema ali seria descrever
  o payload do Stripe como se fosse contrato nosso — e ele é do Stripe,
  muda quando eles querem, e o único campo que nos importa
  (`stripe-signature`, no header) nem está no corpo. O documento diz:
  corpo opaco, header obrigatório, autenticação é a assinatura.

- **Classes de resposta são tipo, não decoração.** Cada `*Response`
  entra como tipo de retorno do handler (`Promise<OrderResponse>`), o
  que faz o TypeScript recusar um campo que o service parou de devolver.
  Isso fecha a divergência por **omissão**, que é a comum. Não fecha a
  divergência por **excesso** (TS aceita propriedade a mais num retorno),
  e é por isso que o `paymentRef` abaixo é resolvido no `select`, não
  esperando por um interceptor.

- **Nada sensível entra no documento.** `passwordHash` e os `tokenHash`
  (refresh, verificação, reset) não cruzam a fronteira hoje e nenhuma
  classe de resposta os introduz. Os exemplos de `@ApiProperty` são
  obviamente falsos — um exemplo que parece segredo real acaba copiado.
  O `clientSecret` e o `refreshToken` **são** devolvidos, de propósito,
  e ficam documentados com a ressalva de que são credenciais.

- **`Order.paymentRef` sai das respostas.** É o `cs_…` do Stripe (ou a
  ref do reembolso), encanamento interno do provedor viajando no
  contrato público desde sempre — não é credencial, ninguém cobra nada
  com ele, mas também não há consumidor pra ele. Removido pelo `select`
  do Prisma, no service, e portanto ausente da classe de resposta. É a
  única mudança de comportamento desta spec, e é subtrativa.

- **Resposta sem corpo é resposta.** Seis rotas respondem `204`
  (`verify-email`, `resend-verification`, `forgot-password`,
  `reset-password`, `logout`, `DELETE /categories/:id`) e dez `POST`
  respondem `200` explícito via `@HttpCode`. Nenhuma tabela de rota das
  specs registrava isso, e o default do Nest pra `POST` é `201` — quem
  gerar cliente pelo default erra em dez rotas.

- **O `204` de `forgot-password` e `resend-verification` é uma
  propriedade de segurança, e o documento tem que dizer isso.** A
  resposta é idêntica exista a conta ou não (`docs/security.md`,
  "Enumeração de contas"). Sem essa frase na descrição, um frontend
  constrói uma tela de "e-mail não cadastrado" que a API nunca vai
  alimentar — e a primeira tentativa de "melhorar" isso reintroduz o
  vazamento.

- **`GET /` vira health check.** Hoje devolve a string `"Hello World!"`
  do scaffold do Nest, e é a única rota que não aparece em spec nenhuma.
  Como o deploy (Railway/Render/Fly) vai querer um path de liveness e o
  roadmap pós-v1 já prevê health-check, ela é promovida em vez de
  documentada como placeholder ou deletada: passa a devolver
  `{ status, version, uptimeSeconds }`. Continua `@Public()`, continua
  sem tocar banco — liveness responde "o processo está de pé", e um
  check que consulta o Postgres vira readiness, que é outra rota e outra
  decisão.

## Superfície da API

Nenhuma rota nova de negócio. O que este módulo adiciona ao mundo:

| Método | Rota         | Descrição                                       | Auth    |
| ------ | ------------ | ----------------------------------------------- | ------- |
| GET    | `/docs`      | Swagger UI                                      | público |
| GET    | `/docs-json` | O documento OpenAPI 3.1 cru                     | público |
| GET    | `/`          | Health check (liveness) — **rota já existente**, muda o corpo | público |

As outras 37 continuam exatamente como estão: mesma URL, mesmo método,
mesmo status, mesmo corpo — exceto pelo `paymentRef` que sai das
respostas de pedido, registrado acima.

### Inventário auditado (38 rotas)

Contagem por controller, conferida contra as tabelas de rota das specs:

| Controller                  | Rotas | Spec                             |
| --------------------------- | ----- | -------------------------------- |
| `AuthController`            | 10    | [auth.md](auth.md)               |
| `ProductsController`        | 6     | [catalog.md](catalog.md)         |
| `CategoriesController`      | 5     | [catalog.md](catalog.md)         |
| `CartController`            | 5     | [orders.md](orders.md)           |
| `OrdersController`          | 9     | [orders.md](orders.md)           |
| `PaymentWebhookController`  | 1     | [payments.md](payments.md)       |
| `ShippingQuoteController`   | 1     | [shipping.md](shipping.md)       |
| `AppController`             | 1     | **esta spec** (não tinha nenhuma) |

Duas rotas são agrupadas pela URL, não pela pasta:
`POST /payments/webhook` e `POST /shipping/quote` moram em `src/orders/`
por razões de dependência de módulo
([modules.md](../architecture/modules.md)), mas quem consome a API vê
`payments` e `shipping` — e é assim que aparecem nas tags.

### Divergências spec ↔ código encontradas na auditoria

Metade do valor deste exercício. Nenhuma rota de spec falta no código;
o inverso e as derivas:

1. **`GET /` não estava em spec nenhuma** — resolvido aqui, virando
   health check.
2. **`weightGrams` falta no esboço de DTO da `catalog.md`.** O campo
   existe em `CreateProductDto`/`UpdateProductDto` e está specado em
   [shipping.md](shipping.md), mas a `catalog.md` — que é a spec
   autoritativa daquelas rotas — nunca recebeu a emenda. Corrigido junto
   com esta spec.
3. **`503` documentado como se fosse de uma rota só** — na verdade seis,
   detalhado nas regras acima.
4. **Nenhuma tabela de rota registra status code**, e dez rotas usam
   `@HttpCode` explícito. Passa a estar no documento gerado, que é o
   lugar certo pra isso viver.

### Tags

Uma por domínio **visto pelo consumidor**, não por pasta:
`auth`, `products`, `categories`, `cart`, `orders`, `payments`,
`shipping`, `health`.

## Critérios de aceitação

- [ ] Dado o app no ar, quando abro `/docs`, então vejo a Swagger UI
      com as 38 operações.
- [ ] Dado `pnpm openapi:generate`, quando roda, então escreve
      `openapi.json` válido sem abrir porta nenhuma.
- [ ] Dado o documento gerado, quando conto operações, então são
      exatamente 38 — e o teste falha se uma rota nova não for
      documentada.
- [ ] Dado o documento gerado, quando olho qualquer rota **não**
      `@Public()`, então ela declara `bearer` como requisito de
      segurança.
- [ ] Dado o documento gerado, quando olho qualquer rota `@Public()`,
      então ela **não** declara requisito de segurança.
- [ ] Dado o documento gerado, quando olho uma rota com
      `@RequirePermissions(X)`, então a descrição do `403` nomeia `X`.
- [ ] Dado o documento gerado, quando olho `POST /payments/webhook`,
      então não há schema de corpo inventado, e o header
      `stripe-signature` está documentado como obrigatório.
- [ ] Dado o documento gerado, quando procuro por `passwordHash`,
      `tokenHash` ou `paymentRef`, então não encontro nenhum.
- [ ] Dado o documento gerado, quando olho as seis rotas de `204`,
      então nenhuma declara corpo de resposta.
- [ ] Dado o documento gerado, quando olho as rotas com rate limit,
      então todas declaram `429`.
- [ ] Dado `GET /`, quando chamo sem token, então recebo `200` com
      `{ status: 'ok', version, uptimeSeconds }`.
- [ ] Dado um `GET /orders/:id` de um pedido pago, quando leio a
      resposta, então `paymentRef` não está presente (e a suíte e2e
      existente continua verde).

## Edge cases conhecidos

- **Rota nova sem decorator** — o teste de contagem pega a rota faltando,
  mas não pega uma rota documentada pela metade (sem `409`, por
  exemplo). Aceito: verificar semântica de erro automaticamente exigiria
  descrever a convenção numa segunda linguagem.
- **`@Public()` + `OptionalJwtAuthGuard`** — o documento diz "sem
  requisito de segurança", que é verdade e insuficiente (o token muda a
  resposta). Coberto por texto na descrição, não por esquema; OpenAPI não
  modela isso.
- **`GET /products/:idOrSlug`** aceita id **ou** slug no mesmo parâmetro
  de path — schema é `string`, e a descrição é quem explica. Não há como
  expressar "uuid ou slug" sem `oneOf` num path param, que gera cliente
  ruim.
- **Enum de status vindo do Prisma gerado** (`ProductStatus`,
  `OrderStatus`) — importado de `src/generated/prisma/enums`, então o
  documento herda o schema; regenerar o Prisma com um valor novo muda o
  documento sem ninguém tocar em decorator. Isso é desejável, mas quer
  dizer que o `openapi.json` commitado pode ficar velho — por isso ele é
  gerado por script, não escrito à mão.
- **`ValidationPipe` com `forbidNonWhitelisted`** devolve `400` com um
  array de mensagens; o documento descreve o formato uma vez, no schema
  de erro compartilhado, em vez de repetir por rota.
- **Swagger UI é público**, inclusive em produção. Consciente: é um
  projeto de portfólio e a API é headless — a documentação sendo
  navegável é parte do que ele demonstra. Nenhuma rota fica menos
  protegida por estar documentada.

## Decisões adiadas

- **Boundary de serialização em runtime.** É o item de verdade. Hoje a
  maioria dos endpoints devolve o model do Prisma direto, então o
  contrato público é "o que a migration deixou na tabela": a próxima
  coluna nova vaza sozinha, sem code review que a pegue. Um
  `ClassSerializerInterceptor` com `@Exclude()` na classe e `@Expose()`
  por campo tornaria isso impossível — a documentação e a resposta
  passariam a ser o mesmo objeto.

  Não entra **agora** porque é mudança de runtime em 38 rotas dentro do
  PR que já toca as 38, e porque o retorno do webhook
  (`{ received, duplicate }`, objeto simples) é um footgun sob
  interceptor global — precisaria de wiring por controller pra não ser
  esvaziado. Fazer as duas coisas num PR só troca um problema conhecido
  por um bug de deploy.

  O que **entra** agora é o que torna isso barato depois: as classes de
  resposta já existem e já são os tipos de retorno. Ligar o interceptor
  vira um PR de configuração mais `@Exclude`/`@Expose`, com a suíte e2e
  atual valendo como rede.
- **Exemplos por rota** — esquema basta pra codegen; exemplo bom exige
  dado realista.
- **Versionamento (`/v1`)** — decisão de rota, não de documentação.
- **Cliente TS publicado** — o `openapi.json` é o insumo; o codegen mora
  no frontend.
- **Readiness check** (o que toca Postgres e provedores) — `GET /` é
  liveness. Readiness é rota própria e entra com observabilidade, no
  roadmap pós-v1.
- **Proteger `/docs`** por basic auth ou por ambiente — se um dia a API
  deixar de ser vitrine de portfólio.
