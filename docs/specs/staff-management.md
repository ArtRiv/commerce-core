# Spec: gestão de acesso (`staff.manage`)

## Status

`in-progress`

## Objetivo

O modelo de autorização deste repositório está pronto e é aplicado em
produção — catálogo de permissões, três papéis, concessão avulsa por usuário, e
o `jwt.strategy` somando papel + avulsas em **toda** requisição autenticada. O
que não existe é **rota**: nenhum dos 38 caminhos da API lista usuário, troca
papel ou concede permissão, e promover a primeira conta a admin é `UPDATE` no
banco — documentado como tal no README.

Esta spec abre quatro rotas atrás de uma permissão nova, `staff.manage`, para
resolver o caso concreto que a motivou: **`operator` lê o catálogo e não pode
cadastrar peça**. Um funcionário contratado para cadastrar não é nenhum dos três
papéis de hoje, e o dono da loja precisa resolver isso sem abrir o Supabase.

É o item 4 de [`../admin-api.md`](../admin-api.md), que já avisava ser "a rota
mais perigosa do sistema inteiro". Metade desta spec é, portanto, sobre **o que
a rota recusa**, não sobre o que ela faz.

## Escopo

### Entra

- `staff.manage` no catálogo de permissões e no papel `admin` — por migration
  (para quem já existe) e por seed (que continua derivando do código)
- `GET /staff` — as contas de equipe, e a busca por e-mail exato que permite
  encontrar quem ainda não é equipe
- `PATCH /staff/{userId}/role` — trocar o papel de uma conta
- `POST /staff/{userId}/permissions` — conceder uma permissão avulsa
- `DELETE /staff/{userId}/permissions/{permission}` — revogar uma permissão
  avulsa
- A guarda do último portador de `staff.manage`
- A regra do que se pode fazer consigo mesmo
- A proveniência da concessão exposta: `grantedById` e `grantedAt` deixam de ser
  colunas desenhadas e nunca lidas

### Não entra (fica pra depois)

- **Ciclo de vida de conta** — suspender, demitir, arquivar. É PR próprio porque
  mexe na autenticação: uma conta suspensa tem que parar de funcionar **agora**,
  o que significa recusar no `jwt.strategy` **e** revogar a família de refresh
  tokens. Suspender sem as duas metades é um botão que não faz nada por quinze
  minutos.
- **LGPD e exclusão de dados.** O direito à eliminação encontra o pedido, que é
  registro fiscal, e o comentário do modelo `User` já diz que a FK de `orders`
  bloqueia deletar quem comprou. É conversa antes de tarefa.
- **Convite por e-mail.** Promover uma conta que já existe resolve o caso com
  muito menos superfície.
- **Listar clientes.** `customers.read` continua sem rota, de propósito: listar
  quem comprou é dado pessoal e esbarra na conversa acima. O recorte da
  invariante 4 existe justamente para que esta spec não a antecipe por acidente.
- **Criar, editar ou apagar papel.** Papéis continuam dado de referência
  derivado de `src/auth/authz/role-permissions.ts` pelo seed. Uma rota que
  edite papel muda o significado de `admin` para todo mundo de uma vez, e isso
  é outra decisão.
- **Trilha de auditoria geral** (`admin_actions`, item 6 do `admin-api.md`).
  Esta spec expõe a proveniência que a tabela `user_permissions` já guardava;
  não inventa registro para as outras escritas do back-office.
- **Qualquer tela.** O `avesso-store` entra depois, quando estas rotas
  estiverem implantadas.

## Regras de negócio / invariantes

### 1. A guarda conta **portadores de `staff.manage`**, não papéis

Como `staff.manage` é permissão e não papel, "a loja ficou sem admin" não é
"ninguém tem o papel `admin`" — é **ninguém consegue mais conceder acesso**. Um
`operator` com a concessão avulsa administra tanto quanto um `admin`; um `admin`
que não existe não protege nada.

Então a contagem é sobre **portadores efetivos**: usuários cujo papel concede
`staff.manage` **união** usuários com a concessão avulsa. É a mesma soma que o
`jwt.strategy` faz por requisição, feita aqui em uma consulta só:

```sql
SELECT u."id" FROM "users" u
WHERE EXISTS (SELECT 1 FROM "role_permissions" rp
                JOIN "permissions" p ON p."id" = rp."permission_id"
               WHERE rp."role_id" = u."role_id" AND p."key" = 'staff.manage')
   OR EXISTS (SELECT 1 FROM "user_permissions" up
                JOIN "permissions" p ON p."id" = up."permission_id"
               WHERE up."user_id" = u."id" AND p."key" = 'staff.manage')
ORDER BY u."id"
FOR UPDATE OF u
```

**Qual operação a guarda protege, hoje.** Só uma: a renúncia — revogar a própria
concessão avulsa (invariante 3). Nas outras, o chamador **é** portador por
construção (a rota exige `staff.manage`) e não pode ser o alvo, então sempre
sobra pelo menos ele.

Ainda assim a guarda é escrita sobre a **contagem**, e não sobre esse
raciocínio, e roda em toda operação que tire `staff.manage` de alguém. O
raciocínio depende de duas outras regras continuarem verdadeiras — "a rota exige
`staff.manage`" e "o alvo nunca é o chamador". Uma guarda que depende de outras
regras é uma guarda que para de guardar em silêncio no dia em que uma delas se
mexe, e este é o único lugar do sistema onde o modo de falha é *ninguém
consegue mais consertar nada pela API*.

**O lock não é zelo.** `FOR UPDATE` com `ORDER BY id`, dentro da transação e
**antes** da escrita, exatamente como a remoção de variante já faz. Sem ele,
dois portadores renunciando ao mesmo tempo leem "existe outro" cada um, e os
dois commitam: a loja fica com zero administradores e as duas requisições
respondem 200. Travar antes de escrever (e não depois) é o que faz as duas
transações **enfileirarem** em vez de deadlockar, e o `ORDER BY` é o que garante
que peguem as linhas na mesma ordem.

A recusa é **409** e a mensagem diz o porquê — não "operação inválida", mas que
a loja ficaria sem ninguém capaz de conceder acesso, que é a informação que
falta para a pessoa entender que precisa promover outra antes.

### 2. `staff.manage` é poder administrativo completo. Está escrito.

Quem tem `staff.manage` pode conceder `staff.manage` — a delegação é delegável,
e isso foi decidido: o dono quer um "sub-chefe" fazendo esse trabalho por ele.
A consequência precisa estar escrita, porque ela não é óbvia na hora de
delegar:

> **Conceder `staff.manage` é conceder tudo.** Não em um passo, mas em dois que
> ninguém pode impedir: quem administra acesso pode trocar o papel de uma conta
> para `admin`, e `admin` é o catálogo inteiro. Delegue `staff.manage` para
> quem você delegaria `admin`, porque é a mesma coisa com um passo a mais.

Consideramos a alternativa — uma lista de permissões que `staff.manage` **não**
pode conceder, ou a regra "só concede o que você mesmo tem" que o
`admin-api.md` sugeria — e ela não fecha. A troca de papel é a porta larga: se
posso pôr alguém em `admin`, a lista do que posso conceder avulso é decoração.
Fechar de verdade exigiria também restringir os papéis atribuíveis àqueles cujo
conjunto de permissões seja subconjunto do meu, o que tira do "sub-chefe"
exatamente a capacidade pela qual ele foi criado. Meia contenção é pior que
nenhuma: ela produz a sensação de um limite que não existe.

O que **de fato** limita o estrago está nas invariantes 3 e 5: ninguém aumenta o
próprio acesso, e toda concessão avulsa fica assinada e datada.

### 3. Ninguém se dá nada. Renunciar é permitido — se sobrar quem administre.

Três operações, três respostas, e a assimetria é o ponto:

| operação sobre si mesmo | resposta |
| --- | --- |
| conceder-se uma permissão | **409, sempre** |
| trocar o próprio papel | **409, sempre** |
| revogar a própria concessão avulsa | **permitido**, salvo a guarda da invariante 1 |

**Conceder-se é a escalada**, literalmente: sem essa recusa, qualquer conta que
alcance a rota se promove ao catálogo inteiro em uma requisição.

**Trocar o próprio papel** é recusado porque papel **não é ordenado**. "Mudar
meu papel" tanto tira quanto dá — `operator` → `admin` é a mesma rota que
`admin` → `operator` — e o chamador é exatamente a pessoa que não deveria
decidir isso sobre si. Quem quer se rebaixar pede a outro administrador; quem é
o único administrador **não deve** poder, e é o que a invariante 1 diz.

**Revogar a própria concessão avulsa é permitido** porque renunciar nunca é
escalada: o conjunto de permissões do chamador só encolhe, e entregar as chaves
é um ato legítimo — é o sub-chefe devolvendo o que recebeu. É também o único
caminho pelo qual a guarda do último administrador é alcançável, e uma guarda
inalcançável é uma guarda que ninguém testa e que ninguém descobre estar
quebrada.

Nada disso é fronteira de segurança contra um insider: quem tem `staff.manage`
promove uma segunda conta e faz por ela o que não pode fazer por si (invariante
2). O que essas regras garantem é que **toda escalada deixa duas linhas com dois
nomes** em vez de uma pessoa se promovendo sozinha e sem rastro — que é a
diferença entre um incidente investigável e um mistério.

### 4. Equipe é papel não-padrão **ou** concessão avulsa — e o e-mail exato é a porta de entrada

"Contas de equipe" **não** é "todos os usuários". Listar cliente é dado pessoal e
esbarra na conversa de LGPD que ainda não aconteceu, e `customers.read` — que
existe no catálogo e hoje só preenche o `buyer` do pedido — é a permissão dessa
outra listagem, não desta.

O recorte é:

> **é equipe quem tem papel diferente do papel padrão, ou ao menos uma linha em
> `user_permissions`.**

Papel padrão é o `is_default` do banco, não a string `'customer'` — é a mesma
leitura que o registro faz para decidir com que papel uma conta nasce, e usar
outra fonte aqui criaria duas definições de "cliente comum".

As duas metades são necessárias. A primeira pega quem foi promovido; a segunda
pega o cliente que recebeu uma concessão avulsa e é equipe **por capacidade**,
ainda que o papel diga o contrário. O recorte é sobre **posição**, não sobre o
conjunto de permissões ser não-vazio: se fosse sobre o conjunto, uma conta
sumiria da tela de gestão no instante em que seu papel fosse esvaziado — e
sumir da tela de gestão é como alguém deixa de poder ser gerenciado.

**A porta de entrada.** Esse recorte tem uma consequência que quebraria a
feature se ficasse implícita: **quem vai ser promovido ainda não é equipe**, e
portanto não aparece na listagem. Sem uma forma de encontrá-lo, promover
continuaria dependendo de pegar o `userId` no banco — que é exatamente o que
esta spec existe para acabar.

Por isso `GET /staff?email=` faz uma busca de **igualdade exata** que atravessa
o recorte: com ela, e só com ela, um cliente comum aparece. Não é enumeração —
é preciso já saber o endereço, e saber o endereço é a credencial do caso de uso
("contratei o Fulano, o e-mail dele é este"). Busca por substring seria
enumeração e por isso **não** existe.

Um e-mail sem conta devolve `items: []` e `total: 0`, não 404: é filtro sobre
coleção, e coleção vazia é uma resposta legítima (ver invariante 6).

### 5. A resposta é escrita campo a campo, e a concessão vem assinada

`User` carrega `passwordHash` e `googleId`. Uma resposta montada por spread ou
por um `select` largo vaza o hash de senha de toda a equipe numa listagem de
back-office — o `admin-api.md` já registrava esse cuidado como não-teórico. O
DTO é escrito campo a campo, deliberadamente, como todos os outros deste
repositório, e há um teste que falha se algum desses nomes aparecer no corpo.

O que a resposta **tem** que trazer é a distinção que o painel precisa desenhar:

- `rolePermissions` — o que vem do papel. Não é revogável por esta API: muda
  trocando o papel.
- `directPermissions` — as avulsas, cada uma com `grantedAt` e `grantedById`.
  São essas que `DELETE` remove.
- `effectivePermissions` — a união, calculada pela **mesma função** que o
  `jwt.strategy` usa (`resolveEffectivePermissions`). Não é conveniência: é o
  que faz a tela mostrar exatamente o que a guarda vai ver, incluindo o
  descarte de chaves que não estão no catálogo.

`grantedById` sai como id, não como e-mail: o concedente é equipe e já está na
mesma listagem, então o painel resolve o nome sem que esta rota espalhe endereço
de e-mail por dentro de outro objeto.

### 6. `404` aqui é só "não existe" — e é onde tem id no caminho

O padrão da casa é "404 é sumiu **ou** não é seu", e ele protege a **existência
de um recurso** de ser confirmada a quem sonda um id (produto `DRAFT`, pedido de
outra pessoa). A `reports.md` registrou onde ele **não** se aplica: rota sem id
não tem existência a vazar.

Aqui as duas metades aparecem, e a distinção é a seguinte:

- **`{userId}` no caminho** → `404` quando não existe conta com aquele id. Não
  há metade "ou não é seu": estas rotas não têm dono, têm permissão. É 404 puro.
- **`DELETE .../permissions/{permission}`** → `404` quando aquela conta não tem
  aquela permissão **como concessão avulsa** — e a mensagem diz que uma
  permissão que vem do papel se remove trocando o papel, porque essa é a
  confusão que o operador vai ter, e um 404 mudo o deixaria clicando de novo.
- **`GET /staff?email=`** → nunca 404. Filtro de coleção devolve coleção vazia.

Não há aqui o que um 403 protegeria: quem chama já tem `staff.manage`, ou seja,
poder administrativo completo (invariante 2), e esconder dele que um e-mail tem
conta seria teatro. O que estas rotas devolvem a quem **não** tem `staff.manage`
é **403**, como toda rota de back-office deste repositório: elas não são leitura
privilegiada de um recurso alheio, são uma capacidade.

### 7. Revogar fecha a porta na requisição seguinte

Não é comportamento novo — é o que o `jwt.strategy` já faz ao resolver papel +
avulsas do banco a cada requisição, em vez de ler do token. Mas passa a ser
**afirmação desta spec**, com teste, porque é a única propriedade do sistema
que estas rotas tornam visível e da qual o dono da loja vai depender: revogar
tem que fechar agora, não em quinze minutos.

O contrário — permissões no token — é a implementação óbvia e é a que faz
"revoguei o acesso do funcionário demitido" significar "revoguei daqui a quinze
minutos". Ter um teste que prova a revogação imediata **com o mesmo token** é o
que impede que uma otimização futura reintroduza isso sem perceber.

O que esta spec **não** revoga é o refresh token: uma conta com acesso reduzido
continua conseguindo renovar sessão, o que está certo (ela continua sendo um
usuário). Cortar a sessão inteira é ciclo de vida de conta, e está fora de
escopo por isso.

### 8. Papel é dado de referência; a troca valida contra o banco

O corpo manda o **nome** (`{"role": "operator"}`), não o id: nomes são únicos, é
o que o painel mostra, e um cuid não é escolha de ninguém.

Um nome que não existe é **400**, com a lista dos papéis válidos na mensagem —
não 404. A diferença: papel, aqui, é **valor** de um vocabulário fechado e
pequeno, não referência a um recurso que o chamador possa ou não enxergar. O 400
pode dizer o que era válido; um 404 não diria. A mesma leitura vale para
`permission`, que é validada contra o catálogo do código (`PERMISSIONS`) e
aparece como `enum` no documento OpenAPI — que é, de quebra, como o painel
descobre quais permissões existem sem que exista uma rota para listá-las.

### 9. A permissão nova chega ao `admin` por migration; o seed continua sendo a fonte

`prisma/seed.ts` deriva catálogo e papéis de `permissions.ts` e
`role-permissions.ts`, e continua sendo a única fonte da verdade — nada de
reference data escrita à mão em dois lugares.

A migration existe por outro motivo: **o banco de produção já existe**. Quem é
`admin` lá tem 14 linhas em `role_permissions`, e a décima quinta não aparece
por mágica quando o código muda. A migration faz o `INSERT` da permissão e o
vínculo com o papel `admin`, com `ON CONFLICT DO NOTHING` para ser idempotente e
para não brigar com o seed que roda logo depois no mesmo deploy.

Sem ela a feature nasce inacessível em produção — ninguém tem `staff.manage`, e
não há rota para conceder `staff.manage` a ninguém, que é a definição de
inalcançável.

A ordem do deploy também importa e já está certa no `entrypoint.sh`: migration
antes do código novo subir. Uma migration aplicada em banco cujo código
implantado ainda não conhece já derrubou a loja uma vez — esta é aditiva
(uma permissão a mais, que nenhum código antigo lê), então é segura nas duas
ordens.

## Superfície da API

Quatro rotas, todas gated em `staff.manage`, todas em um controller novo.

| Método | Rota | Descrição | Auth |
| ------ | ---- | --------- | ---- |
| GET    | `/staff` | contas de equipe; `email` exato encontra quem ainda não é | `staff.manage` |
| PATCH  | `/staff/{userId}/role` | troca o papel da conta | `staff.manage` |
| POST   | `/staff/{userId}/permissions` | concede uma permissão avulsa | `staff.manage` |
| DELETE | `/staff/{userId}/permissions/{permission}` | revoga uma permissão avulsa | `staff.manage` |

`staff.manage` entra no catálogo (15 permissões) e vai **só** para `admin`, que
o recebe por `Object.values(PERMISSIONS)`. `operator` **não** o recebe: um
operador é quem opera a loja, não quem contrata para ela.

As três rotas de escrita devolvem a conta inteira, já atualizada — o painel
redesenha a linha sem uma segunda chamada, e a resposta é a prova do que ficou
valendo.

**Onde o módulo mora.** `StaffController` e `StaffService` ficam **dentro do
`auth`**, não em um módulo novo. `users`, `roles`, `role_permissions` e
`user_permissions` são tabelas do `auth`; um módulo `staff` separado precisaria
lê-las e **escrevê-las** direto, o que seria uma segunda exceção ao mapa de
módulos — e, ao contrário da do `reports`, com escrita. Nenhuma seta nova no
diagrama.

### DTOs (esboço)

```ts
export class ListStaffQueryDto {
  /** Igualdade exata. Atravessa o recorte de equipe — ver invariante 4. */
  email?: string;
  page?: number;
  perPage?: number;
}

export class ChangeRoleDto {
  /** Nome do papel, não id. Desconhecido é 400 com os válidos na mensagem. */
  role: string;
}

export class GrantPermissionDto {
  /** Chave do catálogo. Fora dele é 400. */
  permission: Permission;
}

export class StaffGrantResponse {
  permission: string;
  grantedAt: Date;
  /** Quem concedeu. Null quando a conta do concedente não existe mais. */
  grantedById: string | null;
}

export class StaffAccountResponse {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** Do papel. Não revogável aqui: muda trocando o papel. */
  rolePermissions: string[];
  /** As avulsas, assinadas e datadas. São estas que DELETE remove. */
  directPermissions: StaffGrantResponse[];
  /** A união, pela mesma função que o jwt.strategy usa. */
  effectivePermissions: string[];
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export class PaginatedStaffResponse {
  items: StaffAccountResponse[];
  total: number;
  page: number;
  perPage: number;
}
```

Ordenação: `email` ascendente. É único, então a página é estável sem desempate,
e é a ordem em que uma pessoa procura um nome numa lista de equipe. `perPage`
clampado em 100, como em todo o resto da API.

## Critérios de aceitação

**A fronteira de quem não tem `staff.manage`**

- [ ] Dado nenhum token, quando chama qualquer uma das quatro, então 401
- [ ] Dado um `customer`, quando chama qualquer uma das quatro, então 403
- [ ] Dado um `operator` (que tem seis permissões e nenhuma delas é esta),
      quando chama qualquer uma das quatro, então 403
- [ ] Dado um `operator` **com `staff.manage` avulso**, então 200 — a delegação
      delegada funciona, que é a decisão 1 inteira
- [ ] Dado o documento OpenAPI, então o 403 de cada uma das quatro nomeia
      `staff.manage`

**Listagem**

- [ ] Dado um `admin` e um `operator`, então os dois aparecem
- [ ] Dado um `customer` sem concessão nenhuma, então ele **não** aparece
- [ ] Dado um `customer` com uma concessão avulsa, então ele aparece
- [ ] Dado o e-mail exato de um `customer` sem concessão, quando `?email=`,
      então ele aparece — e é o único caminho pelo qual aparece
- [ ] Dado um e-mail sem conta, então `items` é `[]` e `total` é 0, não 404
- [ ] Dada qualquer resposta desta API, então ela não contém `passwordHash` nem
      `googleId`
- [ ] Dado um usuário com papel `operator` e `products.create` avulso, então
      `effectivePermissions` é a união dos dois, e `directPermissions` traz
      `grantedById` e `grantedAt`

**Trocar papel**

- [ ] Dado um `customer`, quando o admin o troca para `operator`, então ele
      passa a ler `GET /orders` com o **mesmo** token
- [ ] Dado um papel inexistente, então 400, e a mensagem nomeia os válidos
- [ ] Dado um `userId` que não existe, então 404
- [ ] Dado que o alvo é o próprio chamador, então 409

**Conceder e revogar**

- [ ] Dado um `operator` sem `products.create`, quando o admin concede, então a
      requisição **seguinte** dele a `POST /products` é 201, com o mesmo token
- [ ] Dado que o admin revoga, então a requisição **seguinte** é 403, com o
      mesmo token e sem esperar o token expirar
- [ ] Dado que ele recebeu `products.create` e nada mais, então
      `POST /orders/{id}/refund` continua 403
- [ ] Dada uma chave fora do catálogo, então 400
- [ ] Dada a mesma concessão duas vezes, então 200 e `grantedAt` continua o da
      primeira
- [ ] Dado que a permissão vem do **papel** e não é avulsa, quando revoga, então
      404 com a mensagem que aponta a troca de papel
- [ ] Dado um `userId` que não existe, então 404
- [ ] Dado que o alvo é o próprio chamador, quando **concede**, então 409

**A guarda do último administrador**

- [ ] Dado que o chamador é o único portador de `staff.manage` (papel
      `operator`, concessão avulsa), quando revoga a própria concessão, então
      409 — e a mensagem diz que a loja ficaria sem quem administre
- [ ] Dados **dois** portadores por concessão avulsa e **nenhuma** conta com o
      papel `admin`, quando um deles revoga a própria concessão, então 200 — a
      contagem é de portadores, não de papéis
- [ ] Dado um `admin` e um `operator` com `staff.manage` avulso, quando o admin
      revoga a concessão do operator, então 200
- [ ] Dado que a conta perdeu `staff.manage`, então a requisição seguinte dela a
      `GET /staff` é 403

**Nada quebra**

- [ ] Dadas as 46 rotas que já existiam, então continuam respondendo o que
      respondiam — a suíte e2e inteira segue verde

## Edge cases conhecidos

- **Conceder uma permissão que o papel já dá.** Permitido, e não é redundância
  inútil: a avulsa **sobrevive** à troca de papel. Um `admin` que receba
  `products.create` avulso e depois seja rebaixado a `customer` continua
  cadastrando peça. É o comportamento certo (foi concedido explicitamente a
  ele), e é uma armadilha para quem rebaixa achando que rebaixar tira tudo — por
  isso a resposta da troca de papel devolve `effectivePermissions`, onde a
  avulsa continua visível.
- **Revogar uma concessão avulsa de quem tem a mesma permissão pelo papel.**
  Remove a linha e não muda nada de efetivo. A resposta mostra isso: a
  permissão sai de `directPermissions` e continua em `effectivePermissions`.
- **O último portador de `staff.manage` é um `admin`.** Ele não consegue se
  rebaixar (invariante 3, troca de papel sobre si é sempre recusada) e ninguém
  mais pode rebaixá-lo, porque quem chamaria precisaria de `staff.manage` e
  seria portanto um segundo portador. A loja não fica sem administrador por
  nenhum caminho desta API.
- **Concorrência entre duas renúncias.** Resolvida pelo lock da invariante 1: a
  segunda transação espera, relê e recusa. Sem o lock, as duas passariam.
- **Concessão a uma conta com e-mail não verificado.** Permitida. Verificação
  governa **login por senha**, não autorização — uma conta que não consegue
  entrar também não usa a permissão, e recusar a concessão só adiaria o trabalho
  do dono para depois de um e-mail que ele não controla.
- **`grantedById` aponta para uma conta apagada.** `onDelete: SetNull` já está
  no schema: a concessão sobrevive sem concedente, e a resposta traz `null`. A
  concessão continua valendo — quem foi embora não leva junto o acesso que deu.
- **Promover um cliente que tem carrinho e pedidos.** Nada acontece com eles:
  papel não toca em `carts` nem em `orders`. Um `operator` continua tendo o
  próprio carrinho — os dois lados da loja vivem na mesma conta, de propósito.
- **A conta do chamador aparece na própria listagem.** Sim, e deve: ela é
  equipe. É também como o painel descobre o que o próprio chamador pode, sem
  que exista `/auth/me`.

## Decisões adiadas

- **Limite de taxa nas rotas de back-office.** Continua não existindo (ressalva
  1 do `admin-api.md`), e agora vale para as rotas mais perigosas do sistema. O
  limite é em memória e por instância, e os baldes são chaveados no IP — o que,
  num painel BFF, é um balde só para a equipe inteira. Decidir isso é uma tarefa
  de operação, não desta spec.
- **`admin_actions`.** Esta spec expõe a proveniência que `user_permissions` já
  guardava; a troca de papel **não** deixa registro de quem a fez, porque
  `users` não tem coluna para isso e criar uma seria metade de uma tabela de
  auditoria. É o item 6 do `admin-api.md` e continua valendo inteiro.
- **Convite por e-mail.** Criar a conta do funcionário em vez de promover uma
  existente.
- **Papéis editáveis por rota.** Hoje `role-permissions.ts` + seed. Uma rota que
  edite papel muda o significado de `admin` para todos de uma vez.
- **Contenção real do `staff.manage`** (invariante 2): fechar exigiria restringir
  **simultaneamente** as permissões concedíveis e os papéis atribuíveis ao que o
  chamador já tem — um fecho de subconjunto sobre as duas rotas. É desenhável, e
  o dia de desenhá-lo é o dia em que existir alguém que administra parte da
  equipe sem administrar a loja inteira.
- **Suspender e demitir.** O motivo de estar fora está no escopo: sem recusar no
  `jwt.strategy` e revogar a família de refresh tokens, suspender é um botão que
  não faz nada por quinze minutos.
