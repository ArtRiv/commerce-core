import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PasswordService } from '../src/auth/password.service';
import { StockService } from '../src/catalog/stock.service';
import { ProductStatus } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './support/app';
import { createUserWithRole, resetCatalogTables } from './support/catalog-db';
import { resetAuthTables } from './support/db';

const PASSWORD = 'correct horse battery staple';

/**
 * Covers the acceptance criteria of docs/specs/catalog.md at the HTTP level,
 * against the real database — including the RBAC 403 criterion that
 * docs/specs/auth.md left open until a protected domain route existed.
 *
 * The stock-concurrency criteria call StockService directly instead of going
 * through a route: the invariant ("two racing decrements, exactly one wins")
 * is about rows and row locks, so only a real database can falsify it, and
 * no HTTP route decrements stock until the orders module exists.
 */
describe('Catalog (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let resetRateLimits: () => void;

  let adminToken: string;
  let operatorToken: string;
  let customerToken: string;

  beforeAll(async () => {
    ({ app, prisma, resetRateLimits } = await createTestApp());
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(PASSWORD);

    await resetAuthTables(prisma);
    await resetCatalogTables(prisma);

    for (const roleName of ['admin', 'operator', 'customer']) {
      await createUserWithRole(prisma, {
        email: `catalog-${roleName}@example.com`,
        passwordHash,
        roleName,
      });
    }

    adminToken = await login('catalog-admin@example.com');
    operatorToken = await login('catalog-operator@example.com');
    customerToken = await login('catalog-customer@example.com');
  });

  beforeEach(async () => {
    await resetCatalogTables(prisma);
    resetRateLimits();
  });

  afterAll(async () => {
    await resetCatalogTables(prisma);
    await resetAuthTables(prisma);
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  async function login(email: string): Promise<string> {
    const response = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  interface ProductVariant {
    id: string;
    label: string;
    position: number;
    stockQuantity: number;
  }

  interface ProductResponse {
    id: string;
    slug: string;
    status: ProductStatus;
    /** The SUM across variants, computed on read. */
    stockQuantity: number;
    variants: ProductVariant[];
    categories: { id: string; name: string; slug: string }[];
  }

  /**
   * A product with one size unless told otherwise. `stockQuantity` here fills
   * that single variant: there is no stock column on a product any more
   * (docs/specs/product-variants.md).
   */
  async function createProduct(
    overrides: Record<string, unknown> = {},
  ): Promise<ProductResponse> {
    const { stockQuantity = 0, ...rest } = overrides;

    const response = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Camiseta Azul',
        priceCents: 4990,
        variants: [{ label: 'Único', stockQuantity }],
        ...rest,
      })
      .expect(201);

    return response.body as ProductResponse;
  }

  /** The only variant of a single-size product — what most tests want. */
  function onlyVariant(product: ProductResponse): string {
    return product.variants[0].id;
  }

  async function createCategory(name: string): Promise<{ id: string }> {
    const response = await http()
      .post('/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name })
      .expect(201);

    return response.body as { id: string };
  }

  describe('POST /products', () => {
    it('creates a DRAFT product with a slug generated from the name', async () => {
      const product = await createProduct();

      expect(product.status).toBe(ProductStatus.DRAFT);
      expect(product.slug).toBe('camiseta-azul');

      const stored = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored.priceCents).toBe(4990);
    });

    it('suffixes the generated slug when two products share a name', async () => {
      await createProduct();
      const second = await createProduct();

      expect(second.slug).toBe('camiseta-azul-2');
    });

    it('409s an explicit slug that is already taken', async () => {
      await createProduct({ slug: 'promo' });

      await http()
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Outra', priceCents: 1000, slug: 'promo' })
        .expect(409);
    });

    it.each([0, -100, 49.9])(
      'rejects priceCents %p with a 400, persisting nothing',
      async (priceCents) => {
        await http()
          .post('/products')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: 'Inválido', priceCents })
          .expect(400);

        expect(await prisma.product.count()).toBe(0);
      },
    );

    it('400s a categoryId that does not exist', async () => {
      await http()
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Camiseta',
          priceCents: 4990,
          categoryIds: ['00000000-0000-4000-8000-000000000000'],
        })
        .expect(400);
    });

    // The acceptance criterion docs/specs/auth.md could not close until a
    // permission-protected domain route existed: an authenticated customer
    // clears the JWT guard and is refused by the permissions guard.
    it('403s a customer — valid token, missing permission', async () => {
      await http()
        .post('/products')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ name: 'Camiseta', priceCents: 4990 })
        .expect(403);

      expect(await prisma.product.count()).toBe(0);
    });

    it('401s a request with no token at all', async () => {
      await http()
        .post('/products')
        .send({ name: 'Camiseta', priceCents: 4990 })
        .expect(401);
    });
  });

  describe('GET /products', () => {
    it('shows the public only ACTIVE products, paginated', async () => {
      await createProduct({ name: 'Rascunho' });
      await createProduct({ name: 'Ativa', status: ProductStatus.ACTIVE });
      await createProduct({
        name: 'Arquivada',
        status: ProductStatus.ARCHIVED,
      });

      const response = await http().get('/products').expect(200);
      const body = response.body as {
        items: { slug: string }[];
        total: number;
        page: number;
        perPage: number;
      };

      expect(body.total).toBe(1);
      expect(body.items.map((p) => p.slug)).toEqual(['ativa']);
      expect(body.page).toBe(1);
      expect(body.perPage).toBe(20);
    });

    it('403s an anonymous status filter', async () => {
      // Not silently clamped to ACTIVE: asking a privileged question gets a
      // refusal, not an answer that quietly means something else.
      await http().get('/products?status=all').expect(403);
    });

    it('403s a customer using the status filter', async () => {
      await http()
        .get('/products?status=all')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
    });

    it('lets an operator list drafts — but not create them', async () => {
      await createProduct({ name: 'Rascunho' });

      const response = await http()
        .get('/products?status=all')
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      const body = response.body as { total: number };
      expect(body.total).toBe(1);

      // Same operator, write verb: products.read does not imply
      // products.create. Read-only back-office is a real role shape.
      await http()
        .post('/products')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ name: 'Nova', priceCents: 1000 })
        .expect(403);
    });

    it('filters by category slug', async () => {
      const { id: categoryId } = await createCategory('Camisetas');
      await createProduct({
        name: 'Na Categoria',
        status: ProductStatus.ACTIVE,
        categoryIds: [categoryId],
      });
      await createProduct({ name: 'Fora', status: ProductStatus.ACTIVE });

      const response = await http()
        .get('/products?category=camisetas')
        .expect(200);
      const body = response.body as { items: { slug: string }[] };

      expect(body.items.map((p) => p.slug)).toEqual(['na-categoria']);
    });
  });

  describe('GET /products — ordering and price range', () => {
    async function threeActive(): Promise<void> {
      await createProduct({
        name: 'Bone Aba Curva',
        priceCents: 11990,
        status: ProductStatus.ACTIVE,
      });
      await createProduct({
        name: 'Camiseta Pesada',
        priceCents: 14990,
        status: ProductStatus.ACTIVE,
      });
      await createProduct({
        name: 'Alfaiataria Preta',
        priceCents: 34990,
        status: ProductStatus.ACTIVE,
      });
    }

    function slugsOf(body: unknown): string[] {
      return (body as { items: { slug: string }[] }).items.map((p) => p.slug);
    }

    it('defaults to newest first', async () => {
      await threeActive();

      const response = await http().get('/products').expect(200);

      expect(slugsOf(response.body)).toEqual([
        'alfaiataria-preta',
        'camiseta-pesada',
        'bone-aba-curva',
      ]);
    });

    it('sorts by price ascending and descending', async () => {
      await threeActive();

      const asc = await http().get('/products?sort=price_asc').expect(200);
      expect(slugsOf(asc.body)).toEqual([
        'bone-aba-curva',
        'camiseta-pesada',
        'alfaiataria-preta',
      ]);

      const desc = await http().get('/products?sort=price_desc').expect(200);
      expect(slugsOf(desc.body)).toEqual([
        'alfaiataria-preta',
        'camiseta-pesada',
        'bone-aba-curva',
      ]);
    });

    it('sorts by name', async () => {
      await threeActive();

      const response = await http().get('/products?sort=name_asc').expect(200);

      expect(slugsOf(response.body)).toEqual([
        'alfaiataria-preta',
        'bone-aba-curva',
        'camiseta-pesada',
      ]);
    });

    it('rejects an unknown sort', async () => {
      await http().get('/products?sort=cheapest').expect(400);
    });

    it('never repeats or drops an item when prices tie', async () => {
      // Three products at the same price: without the id tiebreaker the two
      // single-item pages can hand back the same row twice.
      await createProduct({
        name: 'Pesada Preta',
        priceCents: 14990,
        status: ProductStatus.ACTIVE,
      });
      await createProduct({
        name: 'Pesada Areia',
        priceCents: 14990,
        status: ProductStatus.ACTIVE,
      });
      await createProduct({
        name: 'Pesada Off White',
        priceCents: 14990,
        status: ProductStatus.ACTIVE,
      });

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const response = await http()
          .get(`/products?sort=price_asc&perPage=1&page=${String(page)}`)
          .expect(200);
        seen.push(...slugsOf(response.body));
      }

      expect(new Set(seen).size).toBe(3);
    });

    it('bounds the catalogue by price, inclusively', async () => {
      await threeActive();

      const min = await http().get('/products?minPriceCents=14990').expect(200);
      expect(slugsOf(min.body).sort()).toEqual([
        'alfaiataria-preta',
        'camiseta-pesada',
      ]);

      const max = await http().get('/products?maxPriceCents=14990').expect(200);
      expect(slugsOf(max.body).sort()).toEqual([
        'bone-aba-curva',
        'camiseta-pesada',
      ]);

      const both = await http()
        .get('/products?minPriceCents=12000&maxPriceCents=20000')
        .expect(200);
      expect(slugsOf(both.body)).toEqual(['camiseta-pesada']);
    });

    it('reports total for the filtered catalogue, not the page', async () => {
      await threeActive();

      const response = await http()
        .get('/products?minPriceCents=12000&perPage=1')
        .expect(200);
      const body = response.body as { items: unknown[]; total: number };

      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(2);
    });

    it('400s an impossible price range instead of returning nothing', async () => {
      await http()
        .get('/products?minPriceCents=20000&maxPriceCents=10000')
        .expect(400);
    });

    it('does not let a price filter reveal a DRAFT product', async () => {
      await createProduct({ name: 'Rascunho Caro', priceCents: 99900 });

      const response = await http()
        .get('/products?minPriceCents=1')
        .expect(200);

      expect(slugsOf(response.body)).toEqual([]);
    });
  });

  describe('GET /categories — productCount', () => {
    it('counts only ACTIVE products', async () => {
      const category = await createCategory('Camisetas');
      await createProduct({
        name: 'Ativa',
        status: ProductStatus.ACTIVE,
        categoryIds: [category.id],
      });
      await createProduct({
        name: 'Rascunho',
        categoryIds: [category.id],
      });

      const response = await http().get('/categories').expect(200);
      const [body] = response.body as { slug: string; productCount: number }[];

      expect(body).toMatchObject({ slug: 'camisetas', productCount: 1 });
    });

    it('reports an empty category as zero', async () => {
      await createCategory('Acessorios');

      const response = await http().get('/categories').expect(200);
      const [body] = response.body as { productCount: number }[];

      expect(body.productCount).toBe(0);
    });

    it('counts a product once in each of its categories', async () => {
      const shirts = await createCategory('Camisetas');
      const sale = await createCategory('Promocao');
      await createProduct({
        name: 'Dupla',
        status: ProductStatus.ACTIVE,
        categoryIds: [shirts.id, sale.id],
      });

      const response = await http().get('/categories').expect(200);
      const body = response.body as { slug: string; productCount: number }[];

      expect(body.map((c) => [c.slug, c.productCount]).sort()).toEqual([
        ['camisetas', 1],
        ['promocao', 1],
      ]);
    });
  });

  describe('GET /products/:idOrSlug', () => {
    it('serves an ACTIVE product to anyone, by slug', async () => {
      await createProduct({ name: 'Pública', status: ProductStatus.ACTIVE });

      const response = await http().get('/products/publica').expect(200);
      expect((response.body as ProductResponse).slug).toBe('publica');
    });

    it('404s a draft for the public, 200s it for products.read', async () => {
      const draft = await createProduct({ name: 'Secreta' });

      // 404, not 403 — a 403 would confirm the unreleased product exists.
      await http().get(`/products/${draft.slug}`).expect(404);

      await http()
        .get(`/products/${draft.slug}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
    });
  });

  describe('DELETE /products/:id', () => {
    it('archives: gone from the storefront, still there for the back office', async () => {
      const product = await createProduct({
        name: 'Vendida',
        status: ProductStatus.ACTIVE,
      });

      await http()
        .delete(`/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const stored = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored.status).toBe(ProductStatus.ARCHIVED);

      await http().get(`/products/${product.id}`).expect(404);

      await http()
        .get(`/products/${product.id}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
    });
  });

  describe('PATCH /products/:id/variants/:variantId/stock', () => {
    it('sets the absolute quantity on the size, and the product sums it', async () => {
      const product = await createProduct({ stockQuantity: 5 });

      const response = await http()
        .patch(`/products/${product.id}/variants/${onlyVariant(product)}/stock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quantity: 12 })
        .expect(200);

      const body = response.body as ProductResponse;
      expect(body.variants[0].stockQuantity).toBe(12);
      // The product's own number is derived, never stored.
      expect(body.stockQuantity).toBe(12);
    });

    it('rejects a negative quantity', async () => {
      const product = await createProduct();

      await http()
        .patch(`/products/${product.id}/variants/${onlyVariant(product)}/stock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quantity: -1 })
        .expect(400);
    });
  });

  describe('StockService.decrement (against the real database)', () => {
    it('gives the last unit to exactly one of two racing decrements', async () => {
      const product = await createProduct({
        status: ProductStatus.ACTIVE,
        stockQuantity: 1,
      });
      const stock = app.get(StockService);

      // Two checkouts, one unit. With a read-check-write implementation both
      // reads would see 1 and both writes would "succeed" — the conditional
      // UPDATE makes Postgres serialize them and refuse the loser.
      const results = await Promise.all([
        stock.decrement(onlyVariant(product), 1),
        stock.decrement(onlyVariant(product), 1),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);

      const stored = await prisma.productVariant.findUniqueOrThrow({
        where: { id: onlyVariant(product) },
        select: { stockQuantity: true },
      });
      expect(stored.stockQuantity).toBe(0);
    });

    it('refuses an insufficient decrement without touching the row', async () => {
      const product = await createProduct({
        status: ProductStatus.ACTIVE,
        stockQuantity: 1,
      });
      const stock = app.get(StockService);

      expect(await stock.decrement(onlyVariant(product), 5)).toBe(false);

      const stored = await prisma.productVariant.findUniqueOrThrow({
        where: { id: onlyVariant(product) },
        select: { stockQuantity: true },
      });
      expect(stored.stockQuantity).toBe(1);
    });

    it('refuses to sell an archived product even with stock on the shelf', async () => {
      const product = await createProduct({
        status: ProductStatus.ARCHIVED,
        stockQuantity: 10,
      });
      const stock = app.get(StockService);

      // The status filter reaches through the relation to the owning
      // product: lifecycle is the product's, stock is the variant's.
      expect(await stock.decrement(onlyVariant(product), 1)).toBe(false);
    });
  });

  describe('categories', () => {
    it('deleting a category detaches its products but keeps them alive', async () => {
      const { id: categoryId } = await createCategory('Efêmera');
      const product = await createProduct({
        name: 'Sobrevivente',
        status: ProductStatus.ACTIVE,
        categoryIds: [categoryId],
      });

      await http()
        .delete(`/categories/${categoryId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      const response = await http()
        .get(`/products/${product.slug}`)
        .expect(200);
      expect((response.body as ProductResponse).categories).toEqual([]);
    });

    it('403s a customer creating a category', async () => {
      await http()
        .post('/categories')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ name: 'Não Pode' })
        .expect(403);
    });
  });
});
