# Workflow: spec → TDD → e2e

Como uma feature nasce neste repo. Isso é convenção interna, não regra
do Nest nem do Jest — o objetivo é ter disciplina de entrega numa v1
pequena, e deixar rastro de por que cada coisa existe.

## 1. Escrever a spec antes de codar

Todo módulo ou feature de tamanho razoável (ex: "login", "checkout",
"controle de estoque") ganha um arquivo em `docs/specs/<nome>.md`,
copiado de [`specs/TEMPLATE.md`](specs/TEMPLATE.md), **antes** de
escrever código de implementação.

A spec não precisa ser longa. O que importa são os **critérios de
aceitação** — viram os testes do passo 2, quase copia-e-cola.

Se no meio da implementação a spec mudar (vai mudar — é normal), edita
a spec primeiro, depois o código. A spec é o que explica _por quê_,
o código é _como_.

## 2. TDD inside-out (unit-first)

Para cada critério de aceitação da spec, na camada de domínio/use-case:

1. **Red** — escreve o teste unitário que falha (o comportamento ainda
   não existe).
2. **Green** — implementa o mínimo pra passar.
3. **Refactor** — limpa, sem mudar comportamento (testes continuam
   verdes).

Repete critério por critério. Mocka só o que cruza a borda do
módulo (ex: `PaymentProvider`, repositório) — não mocka classes do
próprio domínio sendo testado.

Testes unitários ficam ao lado do arquivo (`*.spec.ts`, já é o default
do Nest CLI e do Jest configurado em `package.json`).

## 3. e2e como rede de segurança, não como driver de design

Depois que o fluxo funciona de ponta a ponta (controller, guards, DTO
validando, etc.), escreve o teste e2e em `test/*.e2e-spec.ts` cobrindo
o critério de aceitação da spec no nível HTTP (request → response).

O e2e não é onde o design é descoberto — isso já aconteceu no passo 2.
Ele existe pra pegar regressão de integração (guard errado, rota
errada, serialização de DTO, etc.).

## 4. Atualizar os docs de arquitetura

Se o módulo passou a depender de outro módulo, ou a integração externa
mudou, atualiza [`architecture/modules.md`](architecture/modules.md)
e/ou [`architecture/overview.md`](architecture/overview.md) antes de
abrir o PR. Diagrama desatualizado é pior que não ter diagrama.

Fluxos importantes (ex: login, checkout) podem ganhar um diagrama de
sequência próprio em `architecture/` — cria quando o fluxo existir de
verdade, não antes.

## Resumo do ciclo

```
spec (docs/specs/x.md)
  → teste unitário falha (red)
  → implementação mínima (green)
  → refactor
  → repete pros próximos critérios
  → teste e2e do fluxo completo
  → atualiza diagrama de módulos se a dependência mudou
  → commit
```
