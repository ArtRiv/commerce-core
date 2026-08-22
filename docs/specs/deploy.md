# Spec: deploy (Render + Supabase)

## Status

`in-progress`

Critério de sucesso da v1 (`claude/context.md`: "Deploy real — este é o
critério de sucesso da v1, não é opcional"). Diferente dos outros
módulos, este quase não cria código: entrega uma **topologia** e um
runbook. A única mudança de comportamento na aplicação é o `trust proxy`,
que é pré-requisito pro rate limiting continuar significando alguma
coisa atrás de um load balancer.

## Objetivo

Colocar a API no ar num endereço público e HTTPS, com Stripe cobrando de
verdade (test mode), migrations aplicadas e e-mail saindo por um domínio
verificado — sem que nenhum segredo entre no repositório e sem que a
suíte e2e local consiga destruir os dados de produção.

## Escopo

### Entra

- Plataforma escolhida, com trade-off registrado (Render free).
- Banco de produção **separado** do banco de desenvolvimento.
- `trust proxy` configurado e obrigatório fora de dev/test.
- Migrations e seed de roles/permissions rodando a cada deploy.
- Catálogo de demonstração com `weightGrams` reais.
- Endpoint público do webhook do Stripe criado e verificado com uma
  compra real em test mode.

### Não entra (fica pra depois)

- Rate limiting distribuído (storage Redis pro throttler). O plano free
  do Render **não escala além de uma instância**, então o balde
  em-memória continua correto por construção enquanto for esse o plano.
  Vira obrigatório no minuto em que houver duas instâncias.
- Readiness probe (`/health/ready`) — ver "Decisões" abaixo.
- Domínio próprio / DNS. `*.onrender.com` serve.
- Ambiente de staging separado.
- Pipeline de deploy no GitHub Actions (o Render já escuta o repo).

## Topologia

```
                    Stripe (test mode)
                          │  webhook assinado
                          ▼
Browser ──HTTPS──▶ Render (proxy) ──▶ commerce-core (1 instância free)
                                              │
                                              ├──▶ Supabase PROD (pooler, IPv4)
                                              └──▶ Resend (nao-responda@fel.tec.br)

Laptop ──▶ Supabase DEV  ← a suíte e2e dá TRUNCATE aqui, e só aqui
```

## Regras de negócio / invariantes

- **Um banco por ambiente.** `test/support/db.ts`,
  `test/support/catalog-db.ts` e `test/support/orders-db.ts` executam
  `TRUNCATE` em `users`, `products`, `categories`, `orders`, `carts` e
  `payment_events`. Se produção dividisse o banco com o desenvolvimento,
  um `pnpm test:e2e` distraído apagaria a loja inteira, sem aviso e sem
  volta. O isolamento é a única defesa que não depende de memória
  humana.
- **Nenhum segredo no repositório.** `.gitignore` já cobre `.env*` com
  glob largo; `render.yaml` declara os nomes das variáveis com
  `sync: false`, nunca os valores.
- **O boot continua fail-closed.** As duas guardas existentes
  (`resolvePaymentProvider`, `resolveShippingTable`) valem em produção
  como valem em qualquer lugar, e o deploy tem que satisfazer as duas de
  verdade — não contorná-las com `NODE_ENV=development`.
- **`req.ip` tem que ser o IP do cliente.** Sem `trust proxy`, atrás do
  proxy do Render todo mundo divide um balde de rate limit só, e os
  limites de `docs/security.md` viram decoração. Com `trust proxy`
  frouxo demais (`true`), qualquer um forja `X-Forwarded-For` e escapa
  do balde. As duas falhas são silenciosas, e é por isso que a
  configuração é obrigatória em vez de ter default.

## Configuração necessária

| Variável                        | Valor em produção                                | Por quê                                                                          |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `NODE_ENV`                      | `production`                                     | Liga as duas guardas de boot. Não é opcional.                                     |
| `TRUST_PROXY_HOPS`              | `1`                                              | Faz `req.ip` significar alguma coisa. Não é o que os limites usam — ver abaixo.   |
| `CLIENT_IP_HEADER`              | `cf-connecting-ip`                               | O que os rate limits **de fato** chaveiam no Render. Ver "Decisões".              |
| `DATABASE_URL`                  | pooler do Supabase **prod**                       | Session mode (`:5432`) — tem IPv4, o host direto `db.*.supabase.co` só tem IPv6.  |
| `JWT_SECRET`                    | novo, só de produção                              | Um segredo compartilhado com o laptop não é segredo de produção.                  |
| `RESEND_API_KEY`                | a existente                                       | —                                                                                 |
| `MAIL_FROM`                     | `Commerce Core <nao-responda@fel.tec.br>`         | Domínio verificado. O sender sandbox só entrega pro dono da conta Resend.         |
| `APP_URL`                       | origem do **frontend**                            | Links de verificação/reset e `success_url` do Stripe.                             |
| `API_URL`                       | `https://<serviço>.onrender.com`                  | Callback do Google OAuth é rota **desta** API.                                    |
| `STRIPE_SECRET_KEY`             | `sk_test_…`                                       | —                                                                                 |
| `STRIPE_WEBHOOK_SECRET`         | `whsec_…` do endpoint **do Render**               | Cada endpoint tem o seu; o do `stripe listen` local não vale aqui.                |
| `SHIPPING_TABLE`                | tabela real                                       | Segunda guarda de boot.                                                           |
| `SHIPPING_DEFAULT_WEIGHT_GRAMS` | `500`                                             | Só vale pra produto sem peso — o catálogo de demonstração preenche os pesos.      |

`STRIPE_CURRENCY`, `STRIPE_CHECKOUT_MODE`, `JWT_ACCESS_TTL` e
`SHIPPING_FREE_ABOVE_CENTS` seguem seus defaults.

Não vão pro Render: `SUPABASE_PUBLISHABLE_KEY` e `SUPABASE_SECRET_KEY`.
Estão no `.env` local mas nenhum arquivo de `src/` as lê — são resquício
de antes do Prisma, e credencial que não é usada só amplia o estrago de
um vazamento.

## Superfície da API

Nenhuma rota nova. `GET /` (liveness, já existente) vira o health check
do Render.

## Critérios de aceitação

Guardas de boot:

- [ ] Dado `NODE_ENV=production` sem `SHIPPING_TABLE`, quando o app sobe,
      então falha com código 1 nomeando a variável.
- [ ] Dado `NODE_ENV=production` sem as chaves do Stripe, quando o app
      sobe, então falha com código 1 nomeando as duas.
- [ ] Dada uma `SHIPPING_TABLE` inválida, quando o app sobe, então falha
      com código 1 nomeando a opção culpada.

`trust proxy`:

- [ ] Dado `TRUST_PROXY_HOPS` não definido e `NODE_ENV=production`,
      quando o app sobe, então falha no boot.
- [ ] Dado `TRUST_PROXY_HOPS=0`, quando o app sobe, então sobe — "sem
      proxy" é uma resposta válida, só não pode ser a resposta implícita.
- [ ] Dado `TRUST_PROXY_HOPS` não numérico ou negativo, quando o app
      sobe, então falha nomeando o valor recebido.
- [ ] Dado `TRUST_PROXY_HOPS` não definido em dev/test, quando o app
      sobe, então sobe com 0 e sem aviso — em localhost não há proxy, e
      0 ali é a resposta certa, não um substituto.
- [x] Dado o app publicado, quando o mesmo cliente estoura o limite de uma
      rota chaveada por IP, então recebe `429` — verificado com
      `POST /auth/forgot-password` sem corpo (cai no fallback de IP, limite
      3/hora).
- [x] Dado o app publicado, quando um cliente forja `X-Forwarded-For`,
      então **não** escapa do próprio balde.
- [x] Dado o app publicado, quando alguém erra a senha da **mesma** conta
      repetidamente, então recebe `429` na 6ª (limite 5/15min, chaveado por
      e-mail) — verificado em produção.

Deploy:

- [ ] Dado o serviço no Render, quando um deploy roda, então
      `prisma migrate deploy` e o seed de roles/permissions rodam antes
      do serviço subir, e um `DATABASE_URL` errado reprova o build.
- [ ] Dado o serviço no ar, quando chamo `GET /`, então recebo `200` com
      `status: "ok"`.
- [ ] Dado o serviço no ar, quando chamo `GET /docs`, então o Swagger
      abre.
- [ ] Dado o banco de produção, quando consulto os roles, então
      `customer`, `operator` e `admin` existem com suas permissões.

Compra real (test mode, ponta a ponta, pelo endereço público):

- [ ] Dado um usuário registrado e verificado, quando faço checkout de um
      carrinho com frete cotado, então recebo `201` com `payment.url` do
      Stripe.
- [ ] Dado o cartão de teste `4242…`, quando pago na página do Stripe,
      então o webhook **do Render** recebe um
      `checkout.session.completed` assinado e o pedido vira `PAID` com
      `paidAt` preenchido.
- [ ] Dado esse pedido, quando consulto `GET /orders/:id`, então o status
      é `PAID`.
- [ ] Dado o e-mail de confirmação, quando o pedido vira `PAID`, então o
      Resend registra a entrega pro domínio verificado.

## Decisões

- **Render free, com os olhos abertos.** Serviço free hiberna após 15
  min sem tráfego e leva ~1 min pra acordar. O webhook do Stripe expira
  em 30s, então uma compra que chega com o app dormindo **falha na
  primeira entrega** e só confirma na retentativa do Stripe (que
  reentrega com backoff por até 3 dias — o evento não se perde, o pedido
  fica `CREATED` no meio tempo). Foi escolhido mesmo assim porque é o
  único plano de custo zero, e custo zero era requisito. Mitigação sem
  custo: um monitor externo (UptimeRobot, 5 min) mantém o serviço
  acordado — 750 horas/mês de free tier cobrem as ~730 horas de um mês,
  então manter **um** serviço sempre acordado cabe na cota.
- **Contar saltos de proxy não funciona no Render; o rate limit chaveia num
  header do edge.** `TRUST_PROXY_HOPS` parte do princípio de que a cadeia
  `X-Forwarded-For` tem comprimento **fixo**. Medindo o serviço publicado,
  ela não tem: com `1` e com `2` os limites por IP nunca dispararam (75
  requisições contra um limite de 60/min; 6 contra um de 3/hora), e uma
  varredura enviando K entradas-sentinela mostrou o `req.ip` caindo
  **dentro** das entradas do cliente de forma intermitente a partir de K=3
  — ou seja, o número de entradas que a plataforma acrescenta varia por
  requisição.

  O modo de falha é o pior possível: cada requisição cai num balde novo, o
  limite deixa de existir e **nada** aparece no log. Foi o que também
  explicou leituras contraditórias no meio do diagnóstico — o processo
  reiniciou e zerou o storage em memória (visível pelo `uptimeSeconds` do
  `GET /`).

  A correção é parar de contar e ler um header que o **edge** escreve. Todo
  serviço do Render fica atrás do Cloudflare, que **define**
  `CF-Connecting-IP` a partir do socket e sobrescreve o que o cliente
  mandar. `CLIENT_IP_HEADER` nomeia esse header em configuração em vez de
  fixá-lo no código: sem a variável, nada muda e `req.ip` continua
  decidindo, então dev local e a suíte e2e seguem iguais.

  A premissa de segurança é que a origem **só** é alcançável pelo edge. No
  Render isso vale. Numa plataforma onde não valer, a variável não deve ser
  setada — ali o header vira passe livre.

- **Migrations no build command, não em pre-deploy.** O pre-deploy
  command do Render exige instância paga. O build command roda com
  `DATABASE_URL` disponível, então `prisma migrate deploy` mais o seed de
  roles/permissions ficam lá. Efeito colateral desejado: um
  `DATABASE_URL` errado **reprova o build** em vez de virar um serviço
  verde que dá 500 na primeira requisição — que é exatamente o que uma
  liveness probe não pegaria.
- **Sem readiness probe.** Considerada e descartada: o health check do
  Render reinicia o serviço quando reprova, e uma probe que consulta o
  banco transforma um soluço do Supabase em restart — o argumento que já
  está escrito em `src/app.controller.ts`. A verificação de banco que o
  deploy precisa acontece no build command, uma vez, no lugar certo.
- **O seed de catálogo é separado do `prisma/seed.ts`.** O seed oficial é
  a fonte de verdade de roles e permissions e roda em todo deploy; um
  catálogo de demonstração é dado de exemplo e roda uma vez, à mão. Misturar
  os dois faria todo deploy reescrever produtos.
- **Pooler do Supabase, não a conexão direta.** `db.<ref>.supabase.co`
  não tem registro A — só IPv6. O host do pooler resolve pra IPv4, o que
  torna a conexão independente de a plataforma ter egress IPv6.

## Edge cases conhecidos

- **Primeira compra depois da hibernação.** Descrito acima; o pedido
  converge quando o Stripe reentrega. `POST /orders/:id/pay` sob demanda
  também devolve `409` corretamente nesse intervalo (spec de payments),
  então nenhuma sessão duplicada é criada.
- **Build roda migration, deploy falha depois.** O banco fica à frente do
  código rodando. Todas as migrations até aqui são aditivas, então a
  versão anterior continua funcionando. Deixa de ser verdade na primeira
  migration destrutiva — quando ela existir, ela vira duas.
- **`charges_enabled: false` na conta Stripe.** A conta não completou o
  onboarding. Test mode funciona assim mesmo; live mode não vai funcionar
  até completar.

## Decisões adiadas

- Storage Redis pro throttler — obrigatório no dia da segunda instância.
- Readiness probe de verdade, junto de observabilidade (roadmap pós-v1).
- Rotação de `JWT_SECRET` sem derrubar todas as sessões.
- Staging separado de produção.
- Um domínio próprio na frente do `*.onrender.com`.
