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

  interface ProductResponse {
    id: string;
    slug: string;
    status: ProductStatus;
    stockQuantity: number;
    categories: { id: string; name: string; slug: string }[];
  }

  async function createProduct(
    overrides: Record<string, unknown> = {},
  ): Promise<ProductResponse> {
    const response = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Camiseta Azul', priceCents: 4990, ...overrides })
      .expect(201);

    return response.body as ProductResponse;
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

  describe('PATCH /products/:id/stock', () => {
    it('sets the absolute quantity', async () => {
      const product = await createProduct({ stockQuantity: 5 });

      const response = await http()
        .patch(`/products/${product.id}/stock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quantity: 12 })
        .expect(200);

      expect(response.body).toEqual({ id: product.id, stockQuantity: 12 });
    });

    it('rejects a negative quantity', async () => {
      const product = await createProduct();

      await http()
        .patch(`/products/${product.id}/stock`)
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
        stock.decrement(product.id, 1),
        stock.decrement(product.id, 1),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);

      const stored = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
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

      expect(await stock.decrement(product.id, 5)).toBe(false);

      const stored = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
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

      expect(await stock.decrement(product.id, 1)).toBe(false);
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
