# Segurança — padrões adotados

Este documento registra decisões de segurança que valem pro projeto
inteiro, não só pra uma feature — pra não ficar redecidindo a mesma
coisa (ou pior, decidindo diferente) toda vez que uma spec nova
precisar de senha, token ou dado sensível.

As referências são o [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/),
em particular o Authentication Cheat Sheet, o Password Storage Cheat
Sheet e o Session Management Cheat Sheet.

## Senhas

- Hash com **argon2id**. Nunca texto puro, nunca hash reversível.
- Política de comprimento, não de composição: mínimo 8 caracteres,
  máximo 128 (o máximo é só pra evitar DoS por input gigante no
  hashing). **Sem** exigir maiúscula/número/símbolo — regra de
  composição forçada tende a produzir senhas previsíveis
  (`Senha123!`) e é uma recomendação explícita do OWASP Authentication
  Cheat Sheet.
- Mensagens de erro de login não indicam se foi o e-mail ou a senha
  que errou.

## Tokens

- **Access token**: JWT, `HS256`, vida curta (15 min). Carrega só o
  necessário pra autorização (`sub`, `role`) — nenhum dado sensível no
  payload, já que JWT não é criptografado, só assinado (qualquer um
  decodifica o conteúdo, só não consegue forjar a assinatura).
- **Refresh token**: vida mais longa (7 dias), rotativo de uso único.
  Reuso de um token já consumido é tratado como sinal de roubo e
  revoga toda a família de tokens daquela sessão.
- **Todo token de uso único** (refresh, verificação de e-mail, reset
  de senha) é armazenado no banco como **hash**, nunca em texto puro —
  mesmo raciocínio de senha: se o banco vazar, os tokens ativos não
  vazam junto.
- `HS256` (simétrico) é suficiente enquanto só o próprio commerce-core
  emite e verifica os tokens. Migrar pra `RS256` (assimétrico) só faz
  sentido se outro serviço precisar verificar tokens de forma
  independente, sem confiar no segredo compartilhado.

## Rate limiting

- Rotas sensíveis (login, registro, refresh, forgot-password) têm
  limite de tentativas via `@nestjs/throttler`. Números exatos estão
  na spec de cada feature (ver
  [`specs/auth.md`](specs/auth.md#regras-de-negócio--invariantes));
  aqui só o princípio: toda rota que aceita credencial ou dispara
  e-mail pra terceiro precisa de rate limit desde o dia 1, não como
  hardening posterior.
- Resposta de limite excedido é `429` com header `Retry-After`, sem
  detalhar o motivo além do óbvio.
- **Rotas sensíveis são limitadas por duas chaves, não uma**: por IP (uma
  origem varrendo muitas contas) e por e-mail do corpo (muitas origens
  martelando uma conta). As duas juntas, porque cada uma sozinha tem um
  furo óbvio — IP some atrás de um pool de proxy, e-mail some quando o
  alvo muda.
- **A chave de IP não pode sair de contagem de saltos atrás de um CDN.**
  `req.ip` depende de a cadeia `X-Forwarded-For` ter comprimento fixo, e
  atrás de um edge ela não tem — medido em produção, o limite por IP
  simplesmente não disparava, sem nada no log. Onde houver um CDN que
  escreva o IP real num header próprio (`CF-Connecting-IP` no
  Cloudflare), a chave sai de lá, via `CLIENT_IP_HEADER`. Isso só é
  seguro enquanto a origem for inalcançável exceto pelo edge — o header
  é confiável porque o edge o **sobrescreve**, não porque tem um nome
  bonito. Detalhes e as medições em
  [`specs/deploy.md`](specs/deploy.md).

## Enumeração de contas

- Endpoints que recebem e-mail de alguém que pode não ter conta (ex:
  `forgot-password`) sempre respondem igual, exista a conta ou não.
  A diferença de comportamento (enviar e-mail ou não) acontece só do
  lado de dentro, nunca na resposta HTTP.

## O que isso não cobre (ainda)

Este documento cresce junto com o projeto — não é uma checklist OWASP
completa aplicada de uma vez. Coisas como 2FA, CSP/security headers,
dependência auditada em CI, e secrets management em produção entram
quando a feature que precisa delas for especificada.
