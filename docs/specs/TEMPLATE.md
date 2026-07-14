# Spec: <nome do módulo/feature>

## Status

`draft` | `in-progress` | `done`

## Objetivo

O que isso resolve, em 1-3 frases. Se não conseguir explicar em 3
frases, a feature provavelmente é grande demais pra uma spec só.

## Escopo

### Entra

-

### Não entra (fica pra depois)

-

## Regras de negócio / invariantes

Coisas que sempre têm que ser verdade, independente do caminho que o
código toma. Ex: "um pedido só pode ir de `pago` pra `enviado`, nunca
o contrário".

-

## Superfície da API

| Método | Rota | Descrição | Auth |
| ------ | ---- | --------- | ---- |
|        |      |           |      |

### DTOs (esboço)

```ts
// esboço, não precisa estar exato — só o suficiente pra guiar os testes
```

## Critérios de aceitação

Cada linha vira (ou inspira) um teste. Formato dado/quando/então
ajuda mas não é obrigatório.

- [ ] Dado ..., quando ..., então ...
- [ ]

## Edge cases conhecidos

Casos limite que já sei que existem, mesmo sem saber ainda a resposta
certa (ex: "o que acontece se o Stripe confirmar o pagamento duas
vezes pro mesmo pedido?").

-

## Decisões adiadas

Coisas que ficaram de fora conscientemente, pra não travar a feature
por causa de um detalhe que pode esperar.

-
