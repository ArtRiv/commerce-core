# Spec: auth

## Status

`implementado`

Entregue em três fases. **Fase 1**: loop core de e-mail/senha — registro,
login, refresh, logout. **Fase 2**: verificação de e-mail via Resend,
reset de senha e rate limiting — o fluxo `registro → verificar → login`
fecha inteiro pela API, sem ninguém tocar no banco. **Fase 3**: Google
OAuth com auto-link.

Todos os critérios de aceitação estão marcados. O último a fechar foi o
de RBAC (403 numa rota protegida), que precisava esperar a primeira rota
de domínio existir — fechou junto com o módulo catalog
([spec](catalog.md)), coberto em `test/catalog.e2e-spec.ts`.

### Buracos de cobertura conhecidos

- `ResendMailService`: o e2e troca o provedor por um fake (senão a suíte
  mandaria e-mail de verdade, e o app nem subiria sem `RESEND_API_KEY`).
  Tudo até a fronteira do provedor é testado; a chamada pro Resend, não.
- O round-trip OAuth do Google: completar de verdade exige o Google. A
  `GoogleStrategy` (mapear profile → `GoogleProfile`) e o resto do fluxo
  não têm teste de ponta a ponta. O que **tem** teste é o que importa —
  o auto-link é exercido contra o banco real chamando o
  `AuthService.loginWithGoogle` direto, porque os critérios de aceitação
  ali são afirmações sobre linhas ("nenhuma conta duplicada"), e mock de
  Prisma não falsifica isso.

## Objetivo

Autenticar usuários por dois métodos (e-mail/senha e Google OAuth) e
autorizar ações via RBAC (`customer`, `operator`, `admin`), usando access
token JWT de vida curta + refresh token rotativo de uso único.

## Escopo

### Entra

- Registro por e-mail/senha
- Verificação de e-mail obrigatória antes do login por senha liberar
  (endpoint de verificação + reenvio), via Resend
- Login por e-mail/senha
- Login social via Google OAuth2 (Authorization Code flow, Passport)
- Vínculo automático de conta quando o e-mail verificado pelo Google
  bate com uma conta já existente (Google garante a posse do e-mail,
  então o auto-link é seguro aqui)
- Emissão de access token (JWT curto) + refresh token rotativo
- Endpoint de refresh (troca refresh token válido por par novo;
  detecta reuso de token já consumido)
- Logout (revoga a família de refresh tokens da sessão atual)
- Reset de senha ("esqueci minha senha") via e-mail, reusando o Resend
  já configurado pra verificação
- Rate limiting nas rotas sensíveis (login, registro, refresh,
  forgot-password) via `@nestjs/throttler`
- RBAC: guard + decorator (`@RequirePermissions(...)`) pra proteger
  rotas por permissão

### Não entra (fica pra depois)

- Login social com outros provedores (Facebook, Apple, etc.)
- Vínculo manual de contas (usuário logado linkando um segundo
  provedor explicitamente) — só o auto-link por e-mail do Google entra
  na v1
- 2FA/MFA

## Regras de negócio / invariantes

- Um usuário tem exatamente uma conta, não importa quantos métodos de
  login usa — ligados pelo e-mail.
- Login por e-mail/senha só é permitido se a conta tiver e-mail
  verificado (`emailVerifiedAt IS NOT NULL`).
- Login via Google não passa pela verificação de e-mail — mas **só**
  quando o Google afirma `email_verified`. Esse campo é a fronteira de
  segurança do auto-link inteiro, não formalidade: é a afirmação do
  Google que substitui o nosso e-mail de verificação. O Google devolve
  endereço não-verificado em algumas configurações de Workspace, e
  aceitar um significaria que qualquer um que consiga pôr o e-mail da
  vítima numa conta Google assume a conta daqui. Sem a afirmação, o
  login é recusado.
- Auto-link casa por `googleId` primeiro, e-mail depois: o subject id do
  Google é estável, enquanto um endereço pode ser reatribuído a outra
  pessoa por quem controla o domínio.
- Conta local ainda não verificada que loga via Google passa a
  verificada — o Google acabou de provar a posse. Se já era verificada,
  a data original é mantida.
- Google é configuração **opcional** (ao contrário do Resend): sem
  `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` o app sobe
  normalmente e as rotas do Google respondem 503. A `GoogleStrategy` só é
  registrada quando as duas variáveis existem.
- Role no registro é sempre a role marcada `isDefault` no banco
  (`customer`). `operator`/`admin` só são atribuídos por ação
  administrativa — nunca escolhido pelo próprio usuário no fluxo de
  registro.
- Autorização é por **permissão**, não por papel. Papéis são linhas no
  banco que mapeiam pra um conjunto de permissões (ver
  `src/auth/authz/permissions.ts`); a rota declara a capacidade que
  precisa (`@RequirePermissions(PERMISSIONS.ORDERS_REFUND)`) e continua
  correta quando a definição de um papel muda. Checar papel direto na
  rota acopla a rota à tabela de papéis.
- E-mail é normalizado (trim + lowercase) na escrita e na busca. Índice
  único do Postgres é case-sensitive, então sem isso
  `Ada@example.com` e `ada@example.com` viram duas contas pra mesma
  caixa — e o auto-link do Google, que devolve o endereço minúsculo,
  não acharia a conta existente.
- Senha nunca é armazenada em texto puro — hash com `argon2id`.
- `passwordHash` é **opcional**: conta criada via Google nunca definiu
  senha. Login por senha numa conta sem hash falha com o mesmo erro
  genérico de senha errada — se respondesse diferente, o endpoint
  viraria um oráculo dizendo quais contas são Google-only.
- Senha: mínimo 8 caracteres, máximo 128 (só pra evitar DoS por input
  gigante) — sem regra de composição forçada (maiúscula/número/
  símbolo), seguindo o OWASP Authentication Cheat Sheet. Ver
  [`docs/security.md`](../security.md).
- Access token: JWT assinado com HS256, vida de 15 min, carrega só
  `sub` (userId). Papel e permissões **não** entram no payload: o token
  é um retrato de 15 min e papéis são editáveis em runtime, então
  permissão embutida envelhece e concede a mais. O `JwtStrategy`
  resolve as permissões do banco a cada request. Stateless — não é
  revogado no logout, só expira sozinho (por isso a vida é curta).
- Refresh token: vida de 7 dias, uso único (rotativo). Reusar um token
  já consumido é sinal de roubo — revoga a família inteira daquela
  sessão, forçando novo login. Armazenado no banco só como hash, nunca
  em texto puro — mesmo tratamento dado à senha.
- Token de verificação de e-mail e de reset de senha: de uso único,
  expiram (verificação: 24h; reset: 1h), armazenados como hash no
  banco pelo mesmo motivo do refresh token.
- Logout revoga a família de refresh tokens atual. Exige o refresh
  token no body além do access token: o access token carrega só `sub`,
  então sozinho ele não identifica *qual* sessão encerrar — revogaria
  todas, que é "sair de todos os dispositivos", não logout. O token
  apresentado precisa pertencer ao usuário autenticado.
- Trocar a senha (via reset) invalida todas as sessões existentes do
  usuário — todas as famílias de refresh token são revogadas, não só
  a atual.
- Completar um reset de senha também **verifica o e-mail**, se ainda não
  estava. Chegar num token de reset significa que a pessoa abriu um link
  que mandamos pra aquele endereço — a mesma prova de posse que o e-mail
  de verificação pede, e a mesma em que o login do Google se apoia. Sem
  isso, quem registra, pula a verificação e depois reseta a senha
  definiria uma senha válida e mesmo assim tomaria 403 no login. Conta já
  verificada mantém a data original (mesmo comportamento do Google).
- Rate limit nas rotas sensíveis (defaults, ajustáveis, todos em
  `src/auth/throttling/rate-limits.ts`): login 5 tentativas / 15 min
  (por IP **e** por conta); registro 5 / hora por IP; forgot-password
  **e resend-verification** 3 / hora por e-mail (evita usar o endpoint
  pra floodar a caixa de entrada de terceiros); refresh 60 / min por IP.
- O limite do refresh é diferente de propósito: refresh token é 256 bits
  de aleatório guardado como hash, não tem o que adivinhar, então não é
  limite anti-brute-force como o do login — é só anti-flood. Por isso é
  generoso: um cliente real dá refresh ~1x por vida do access token
  (~15 min), e um número apertado por IP puniria vários usuários atrás
  de um NAT por uma ameaça que aqui não existe.
- `resend-verification` não estava na lista original da spec, mas
  dispara e-mail pra terceiro igual ao forgot-password — mesmo vetor de
  abuso, mesmo limite. O princípio em [`docs/security.md`](../security.md)
  já mandava isso; a lista é que estava incompleta.
- Limitar por e-mail além de IP porque IP sozinho é a chave errada:
  atacante com pool de proxies ganha orçamento novo por endereço,
  enquanto um escritório atrás de um NAT divide um orçamento entre
  todos. A chave certa é a conta sendo atacada.
- Contador de rate limit é em memória: cada instância conta a sua. Certo
  pra um processo, errado no dia que rodar em mais de um — trocar pro
  storage de Redis é mudança só no `AppModule`.

## Superfície da API

| Método | Rota                        | Descrição                                         | Auth                 |
| ------ | --------------------------- | ------------------------------------------------- | -------------------- |
| POST   | `/auth/register`            | Cria conta, dispara e-mail de verificação         | público              |
| POST   | `/auth/verify-email`        | Confirma e-mail via token recebido                | público              |
| POST   | `/auth/resend-verification` | Reenvia e-mail de verificação                     | público              |
| POST   | `/auth/login`               | Login e-mail/senha (exige e-mail verificado)      | público              |
| GET    | `/auth/google`              | Inicia o OAuth flow do Google                     | público              |
| GET    | `/auth/google/callback`     | Callback do Google, emite tokens                  | público              |
| POST   | `/auth/refresh`             | Troca refresh token válido por novo par           | refresh token no body |
| POST   | `/auth/logout`              | Revoga a família de refresh token da sessão atual | autenticado + refresh token no body |
| POST   | `/auth/forgot-password`     | Dispara e-mail de reset, se a conta existir       | público              |
| POST   | `/auth/reset-password`      | Define nova senha via token de reset              | público              |

### DTOs (esboço)

```ts
class RegisterDto {
  email: string;
  password: string;
  name: string;
}

class LoginDto {
  email: string;
  password: string;
}

// Usado por /auth/refresh e /auth/logout.
class RefreshTokenDto {
  refreshToken: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// Usado por /auth/resend-verification e /auth/forgot-password — mesma
// forma, e ambos respondem igual exista a conta ou não.
class EmailDto {
  email: string;
}

class VerifyEmailDto {
  token: string;
}

class ResetPasswordDto {
  token: string;
  newPassword: string;
}
```

### Configuração necessária

Ver [`.env.example`](../../.env.example) pro arquivo completo.

| Variável         | Para quê                                     |
| ---------------- | -------------------------------------------- |
| `RESEND_API_KEY` | Envio de e-mail. Sem ela o app não sobe.     |
| `MAIL_FROM`      | Remetente dos e-mails (domínio verificado no Resend; sem domínio, o sandbox `onboarding@resend.dev`). |
| `APP_URL`        | Base do **frontend**. Os links de verificação/reset apontam pra cá — abrem numa página que lê o token e chama a API. |
| `API_URL`        | Base **desta API**. O callback do Google é rota daqui, então a callback URL sai disso. Origens diferentes do `APP_URL`, por isso duas variáveis. |
| `GOOGLE_OAUTH_CLIENT_ID`     | Login com Google. Opcional — sem ela as rotas do Google dão 503. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Idem. O redirect autorizado no console do Google tem que bater **exato** com `${API_URL}/auth/google/callback`. |

## Critérios de aceitação

Legenda: `[x]` entregue e coberto por teste, `[~]` parcial (o que falta
está anotado no item), `[ ]` fase 2. Os itens marcados são cobertos por
`test/auth.e2e-spec.ts` no nível HTTP, mais os unitários ao lado do
código.

- [x] Dado um e-mail novo, quando registro com senha, então a conta é
      criada com `emailVerifiedAt = null` e um e-mail de verificação é
      disparado.
- [x] Dado um e-mail não verificado, quando tento logar com
      e-mail/senha, então o login é rejeitado (401/403, mensagem clara
      de "verifique seu e-mail").
- [x] Dado o token de verificação correto, quando chamo
      `/auth/verify-email`, então `emailVerifiedAt` é preenchido e o
      login por senha passa a funcionar.
- [x] Dado um e-mail verificado e senha correta, quando faço login,
      então recebo `accessToken` + `refreshToken` válidos.
- [x] Dado um e-mail verificado e senha errada, quando faço login,
      então recebo erro, sem indicar se o problema foi o e-mail ou a
      senha (não vazar qual dos dois está errado).
- [x] Dado um usuário que nunca logou, quando completa o fluxo do
      Google OAuth, então uma conta nova é criada com e-mail já
      verificado (`emailVerifiedAt` = data do login) e role `customer`.
- [x] Dado um usuário já cadastrado por e-mail/senha, quando completa
      o fluxo do Google OAuth com o mesmo e-mail, então nenhuma conta
      duplicada é criada — a conta existente é vinculada.
- [x] Dado um refresh token válido e não usado, quando chamo
      `/auth/refresh`, então recebo um novo par de tokens e o token
      antigo deixa de funcionar.
- [x] Dado um refresh token já consumido, quando é reapresentado em
      `/auth/refresh`, então toda a família de tokens da sessão é
      revogada e a resposta é de erro.
- [x] Dado um usuário autenticado, quando chama `/auth/logout`, então
      a família de refresh token atual é revogada (um refresh
      subsequente falha).
- [x] Dado um usuário com role `customer`, quando acessa uma rota
      protegida com `@RequirePermissions(...)`, então recebe 403.
      (Fechado pelo módulo catalog: a rota real é `POST /products` com
      `PRODUCTS_CREATE` — a spec original citava `ORDERS_REFUND` como
      exemplo hipotético, orders ainda não existia. Coberto em
      `test/catalog.e2e-spec.ts`, incluindo a variação operator: tem
      `products.read`, toma 403 no create.)
- [x] Dado um e-mail de conta existente, quando chamo
      `/auth/forgot-password`, então um e-mail com link de reset é
      disparado e a resposta da API não revela se a conta existe.
- [x] Dado um e-mail que não tem conta, quando chamo
      `/auth/forgot-password`, então a resposta é idêntica à do caso
      acima (sem vazar existência da conta), mas nenhum e-mail é
      enviado.
- [x] Dado um token de reset válido e não usado, quando chamo
      `/auth/reset-password` com senha nova, então a senha é
      atualizada e todas as sessões anteriores do usuário deixam de
      funcionar (refresh tokens antigos revogados).
- [x] Dado um token de reset expirado ou já usado, quando chamo
      `/auth/reset-password`, então a operação falha sem alterar a
      senha.
- [x] Dado mais de 5 tentativas de login falhas em 15 min pra mesma
      conta, quando tento logar de novo, então recebo 429 mesmo com a
      senha correta.

## Edge cases conhecidos

- Registro com e-mail já existente e verificado → erro de conflito
  (409), não silencioso.
- Registro com e-mail já existente mas **não verificado** → em vez de
  criar duplicata, reenviar o e-mail de verificação (mesma UX de
  "esqueci que já me cadastrei").
- Falha ao enviar o e-mail de verificação (provedor fora do ar) → a
  conta é criada mesmo assim; usuário consegue pedir reenvio depois.
  Não travar o registro por causa do e-mail.
- Usuário nega a permissão no consent screen do Google, ou o callback
  falha → erro tratado, sem stack trace vazando pro cliente.
- Conta que só tem login via Google (nunca definiu senha) recebe um
  `/auth/forgot-password` → resposta da API é a mesma genérica de
  sempre (não vazar como a conta foi criada), mas nenhum e-mail de
  reset é enviado — se quisermos, o e-mail que a pessoa _já não vai
  receber_ poderia futuramente virar um aviso "essa conta usa login
  Google", mas isso é opcional, não bloqueia a v1.
- Excedeu o rate limit (login, registro ou forgot-password) → resposta
  429 com header `Retry-After`, sem detalhar o motivo além do óbvio.

## Decisões adiadas

- **Provedor de e-mail: Resend** — novo em relação ao escopo original
  da v1 (o `claude/context.md` só previa envio de e-mail pós-v1, junto
  da fila de jobs). Verificação de e-mail obrigatória puxa isso pra
  agora, mas como chamada síncrona simples no `AuthService` — sem
  fila ainda.
- Migração futura de HS256 pra RS256, se algum dia outro serviço
  precisar verificar tokens sem confiar no segredo compartilhado —
  não necessário no monolito atual.
- Vínculo manual de contas (usuário logado linkando um segundo
  provedor por escolha própria, não por e-mail batendo).
- Números exatos de rate limit (5/15min etc.) são default inicial,
  ajustar com dado real depois do deploy.
