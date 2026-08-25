# Spec: catalog-query

## Status

`draft`

## Objetivo

Dar a `GET /products` a ordenação e o filtro por faixa de preço que a
tela de catálogo precisa, e a `GET /categories` a contagem de produtos
que a trilha lateral e a faixa de categorias da home exibem. Hoje os três
números só podem ser fabricados no cliente, e só ficam certos enquanto o
catálogo inteiro couber numa página.

## Escopo

### Entra

- `sort` em `GET /products`: `newest` (padrão) · `price_asc` ·
  `price_desc` · `name_asc`
- `minPriceCents` / `maxPriceCents` em `GET /products`, inclusivos, em
  centavos inteiros
- `productCount` em `CategoryResponse`, contando só produtos `ACTIVE`
- Desempate determinístico por `id` em toda ordenação, para a paginação
  não repetir nem pular item quando dois produtos empatam

### Não entra (fica pra depois)

- Busca com motor de verdade (full-text, relevância, typo tolerance) — a
  busca continua `ILIKE` no nome
- Facetas, filtro por múltiplas categorias, ordenação por mais de um
  campo por vez
- Paginação por cursor
- Ordenação de `GET /categories` (continua alfabética, sem parâmetro)
- Contagem por faixa de preço vinda do servidor — a trilha calcula as
  suas quatro faixas a partir de `total` por requisição

## Regras de negócio / invariantes

- **Ordenar e paginar são a mesma operação.** Um `ORDER BY` aplicado
  depois do `LIMIT` ordena a página, não o catálogo. Por isso a
  ordenação é do servidor, e por isso ela nunca pode ser "resolvida" no
  cliente sem deixar de estar certa em algum tamanho de catálogo.
- **Toda ordenação termina em `id asc`.** Sem desempate, dois produtos de
  mesmo preço podem trocar de posição entre duas consultas e a paginação
  passa a repetir um e esconder o outro. Três camisetas a R$ 149,90 no
  catálogo de demonstração já reproduzem isso.
- **Preço é inteiro em centavos.** `minPriceCents` e `maxPriceCents` são
  inteiros, inclusivos nas duas pontas. Não existe filtro por preço em
  reais, nem em float, em nenhuma camada.
- **`minPriceCents > maxPriceCents` é `400`.** Um intervalo impossível é
  erro do chamador, não uma lista vazia — devolver `[]` esconde o bug de
  quem chamou.
- **A contagem de categoria conta o que a grade mostra.** Só `ACTIVE`.
  Uma trilha que diz `Camisetas (5)` sobre uma grade de 3 peças está
  mentindo, e a mentira é pior que a ausência do número.
- **O padrão não muda.** Sem `sort`, a ordem continua `createdAt desc`,
  igual à de hoje. Nenhum cliente existente muda de comportamento.
- Filtro de preço e filtro de status são independentes: a faixa de preço
  não vaza produto `DRAFT` para quem não tem `products.read`.

## Superfície da API

| Método | Rota | Descrição | Auth |
| ------ | ---- | --------- | ---- |
| GET | `/products` | ganha `sort`, `minPriceCents`, `maxPriceCents` | pública |
| GET | `/categories` | resposta ganha `productCount` | pública |

Nenhuma rota nova. Nenhuma migration: os três recursos saem de `ORDER BY`,
`WHERE` e um `_count` sobre o schema que já existe.

### DTOs (esboço)

```ts
export const PRODUCT_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'name_asc',
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export class ListProductsQueryDto {
  // ... page, perPage, category, search, status (inalterados)

  @IsOptional() @IsIn(PRODUCT_SORTS)
  sort?: ProductSort;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  minPriceCents?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  maxPriceCents?: number;
}

export class CategoryResponse {
  // ... id, name, slug, description, createdAt, updatedAt (inalterados)
  productCount: number; // só ACTIVE
}
```

Mapa de ordenação, no serviço:

```ts
const ORDER_BY: Record<ProductSort, Prisma.ProductOrderByWithRelationInput[]> = {
  newest:     [{ createdAt: 'desc' }, { id: 'asc' }],
  price_asc:  [{ priceCents: 'asc' }, { id: 'asc' }],
  price_desc: [{ priceCents: 'desc' }, { id: 'asc' }],
  name_asc:   [{ name: 'asc' }, { id: 'asc' }],
};
```

## Critérios de aceitação

- [ ] Dado nenhum `sort`, quando listo produtos, então a ordem é
      `createdAt desc` — idêntica à de antes desta spec
- [ ] Dado `sort=price_asc`, quando listo, então o menor `priceCents` vem
      primeiro; com `price_desc`, o maior
- [ ] Dado `sort=name_asc`, quando listo, então a ordem é alfabética por
      nome
- [ ] Dado `sort=xpto`, quando listo, então `400`
- [ ] Dados dois produtos de preço igual, quando listo com `price_asc` em
      duas páginas de tamanho 1, então cada produto aparece exatamente uma
      vez — nunca o mesmo duas vezes
- [ ] Dado `minPriceCents=15000`, quando listo, então nenhum item custa
      menos que 15000, e o de exatamente 15000 está incluído
- [ ] Dado `maxPriceCents=15000`, quando listo, então nenhum item custa
      mais que 15000, e o de exatamente 15000 está incluído
- [ ] Dados `minPriceCents=20000` e `maxPriceCents=10000`, quando listo,
      então `400`
- [ ] Dado um filtro de preço combinado com `category` e `search`, quando
      listo, então os três se aplicam juntos e `total` reflete a
      combinação, não só a página
- [ ] Dado um produto `DRAFT` dentro da faixa de preço, quando listo sem
      `products.read`, então ele não aparece
- [ ] Dada uma categoria com 3 produtos `ACTIVE` e 2 `DRAFT`, quando leio
      `/categories`, então `productCount` é 3
- [ ] Dada uma categoria sem produto nenhum, quando leio `/categories`,
      então `productCount` é 0 — não ausente, não `null`
- [ ] Dado que um produto pertence a duas categorias, quando leio
      `/categories`, então ele conta 1 em cada uma
- [ ] O documento OpenAPI regenerado descreve `sort`, `minPriceCents`,
      `maxPriceCents` e `productCount`

## Edge cases conhecidos

- **Colação de `name_asc`.** A ordem alfabética de nomes com acento
  depende da colação do Postgres. `Boné`, `Calça` e `Jaqueta` precisam
  cair onde um falante de português espera. Verificar contra a colação do
  Supabase antes de fechar, e registrar o resultado aqui.
- **`productCount` custa uma agregação.** `GET /categories` é descrito
  como cacheável pela navegação da loja; a contagem não pode transformar
  uma leitura barata em varredura por categoria. Um `_count` filtrado
  resolve numa consulta só.
- **`perPage` alto com ordenação por preço** continua limitado a 100 pelo
  serviço — a ordenação não é desculpa para pedir o catálogo inteiro.
- Faixa de preço com valores negativos: barrada por `@Min(0)`, não por
  regra de serviço.

## Decisões adiadas

- **`productCount` sensível a permissão.** Quem tem `products.read`
  poderia querer a contagem incluindo `DRAFT` e `ARCHIVED`. Fica de fora:
  faria o payload variar por permissão e mataria a cacheabilidade que é a
  razão de `/categories` ser não paginada. Se o back-office precisar,
  vira um parâmetro explícito depois.
- **Contagem por faixa de preço no servidor.** A trilha do catálogo exibe
  quatro faixas com contagem; por ora o front pede `total` por faixa ou
  calcula sobre o catálogo completo enquanto ele couber numa página. Se o
  catálogo crescer, isto vira um agregado no servidor.
- **Ordenação por relevância de busca.** Depende de ter busca de verdade,
  que está explicitamente fora de escopo.
