# Spec: auth

## Status

`draft`

## Objetivo

Autenticar usuários por dois métodos (e-mail/senha e Google OAuth) e
autorizar ações via RBAC (`cliente`, `operador`, `admin`), usando access
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
- RBAC: guard + decorator (`@Roles(...)`) pra proteger rotas por papel

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
- Login via Google não passa pela verificação de e-mail: o Google já
  garante a posse.
- Role no registro é sempre `cliente`. `operador`/`admin` só são
  atribuídos por ação administrativa — nunca escolhido pelo próprio
  usuário no fluxo de registro.
- Senha nunca é armazenada em texto puro — hash com `argon2id`.
- Senha: mínimo 8 caracteres, máximo 128 (só pra evitar DoS por input
  gigante) — sem regra de composição forçada (maiúscula/número/
  símbolo), seguindo o OWASP Authentication Cheat Sheet. Ver
  [`docs/security.md`](../security.md).
- Access token: JWT assinado com HS256, vida de 15 min, carrega `sub`
  (userId) e `role`. Stateless — não é revogado no logout, só expira
  sozinho (por isso a vida precisa ser curta).
- Refresh token: vida de 7 dias, uso único (rotativo). Reusar um token
  já consumido é sinal de roubo — revoga a família inteira daquela
  sessão, forçando novo login. Armazenado no banco só como hash, nunca
  em texto puro — mesmo tratamento dado à senha.
- Token de verificação de e-mail e de reset de senha: de uso único,
  expiram (verificação: 24h; reset: 1h), armazenados como hash no
  banco pelo mesmo motivo do refresh token.
- Logout revoga a família de refresh tokens atual.
- Trocar a senha (via reset) invalida todas as sessões existentes do
  usuário — todas as famílias de refresh token são revogadas, não só
  a atual.
- Rate limit nas rotas sensíveis (defaults, ajustáveis): login 5
  tentativas / 15 min (por IP + por conta); registro 5 / hora por IP;
  forgot-password 3 / hora por e-mail (evita usar o endpoint pra
  floodar a caixa de entrada de terceiros).

## Superfície da API

| Método | Rota                        | Descrição                                         | Auth                 |
| ------ | --------------------------- | ------------------------------------------------- | -------------------- |
| POST   | `/auth/register`            | Cria conta, dispara e-mail de verificação         | público              |
| POST   | `/auth/verify-email`        | Confirma e-mail via token recebido                | público              |
| POST   | `/auth/resend-verification` | Reenvia e-mail de verificação                     | público              |
| POST   | `/auth/login`               | Login e-mail/senha (exige e-mail verificado)      | público              |
| GET    | `/auth/google`              | Inicia o OAuth flow do Google                     | público              |
| GET    | `/auth/google/callback`     | Callback do Google, emite tokens                  | público              |
| POST   | `/auth/refresh`             | Troca refresh token válido por novo par           | refresh token válido |
| POST   | `/auth/logout`              | Revoga a família de refresh token da sessão atual | autenticado          |
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

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

class ForgotPasswordDto {
  email: string;
}

class ResetPasswordDto {
  token: string;
  newPassword: string;
}
```

## Critérios de aceitação

- [ ] Dado um e-mail novo, quando registro com senha, então a conta é
      criada com `emailVerifiedAt = null` e um e-mail de verificação é
      disparado.
- [ ] Dado um e-mail não verificado, quando tento logar com
      e-mail/senha, então o login é rejeitado (401/403, mensagem clara
      de "verifique seu e-mail").
- [ ] Dado o token de verificação correto, quando chamo
      `/auth/verify-email`, então `emailVerifiedAt` é preenchido e o
      login por senha passa a funcionar.
- [ ] Dado um e-mail verificado e senha correta, quando faço login,
      então recebo `accessToken` + `refreshToken` válidos.
- [ ] Dado um e-mail verificado e senha errada, quando faço login,
      então recebo erro, sem indicar se o problema foi o e-mail ou a
      senha (não vazar qual dos dois está errado).
- [ ] Dado um usuário que nunca logou, quando completa o fluxo do
      Google OAuth, então uma conta nova é criada com e-mail já
      verificado (`emailVerifiedAt` = data do login) e role `cliente`.
- [ ] Dado um usuário já cadastrado por e-mail/senha, quando completa
      o fluxo do Google OAuth com o mesmo e-mail, então nenhuma conta
      duplicada é criada — a conta existente é vinculada.
- [ ] Dado um refresh token válido e não usado, quando chamo
      `/auth/refresh`, então recebo um novo par de tokens e o token
      antigo deixa de funcionar.
- [ ] Dado um refresh token já consumido, quando é reapresentado em
      `/auth/refresh`, então toda a família de tokens da sessão é
      revogada e a resposta é de erro.
- [ ] Dado um usuário autenticado, quando chama `/auth/logout`, então
      a família de refresh token atual é revogada (um refresh
      subsequente falha).
- [ ] Dado um usuário com role `cliente`, quando acessa uma rota
      protegida com `@Roles('admin')`, então recebe 403.
- [ ] Dado um e-mail de conta existente, quando chamo
      `/auth/forgot-password`, então um e-mail com link de reset é
      disparado e a resposta da API não revela se a conta existe.
- [ ] Dado um e-mail que não tem conta, quando chamo
      `/auth/forgot-password`, então a resposta é idêntica à do caso
      acima (sem vazar existência da conta), mas nenhum e-mail é
      enviado.
- [ ] Dado um token de reset válido e não usado, quando chamo
      `/auth/reset-password` com senha nova, então a senha é
      atualizada e todas as sessões anteriores do usuário deixam de
      funcionar (refresh tokens antigos revogados).
- [ ] Dado um token de reset expirado ou já usado, quando chamo
      `/auth/reset-password`, então a operação falha sem alterar a
      senha.
- [ ] Dado mais de 5 tentativas de login falhas em 15 min pra mesma
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
