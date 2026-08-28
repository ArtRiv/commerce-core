import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PERMISSIONS } from '../src/auth/authz/permissions';
import { PasswordService } from '../src/auth/password.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './support/app';
import { createUserWithRole, resetCatalogTables } from './support/catalog-db';
import { resetAuthTables } from './support/db';
import { resetOrdersTables } from './support/orders-db';

const PASSWORD = 'correct horse battery staple';

/**
 * Covers the acceptance criteria of docs/specs/variant-management.md at the
 * HTTP level, against the real database.
 *
 * A file of its own rather than more of catalog.e2e-spec.ts, because these
 * cases straddle three modules: a variant removal has to be refused by an
 * ORDER and has to take a CART line with it, so this suite owns orders and
 * carts as well as the catalog and resets all three.
 *
 * Three of its assertions cannot be made anywhere but here:
 *
 *  - a size that was sold is refused, and the order survives intact;
 *  - the cart line really disappears, and the owner's cart re-totals;
 *  - the recount aborts when a fourth cart arrives between the warning and
 *    the confirmation — a race a mock can only pretend to have.
 */
describe('Variant management (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let resetRateLimits: () => void;

  let adminToken: string;
  /** Holds products.update but NOT products.delete — the permission split. */
  let editorToken: string;
  let customerToken: string;
  let customerId: string;

  beforeAll(async () => {
    ({ app, prisma, resetRateLimits } = await createTestApp());
    const passwords = app.get(PasswordService);
    const passwordHash = await passwords.hash(PASSWORD);

    await resetOrdersTables(prisma);
    await resetCatalogTables(prisma);
    await resetAuthTables(prisma);

    await createUserWithRole(prisma, {
      email: 'variants-admin@example.com',
      passwordHash,
      roleName: 'admin',
    });
    const customer = await createUserWithRole(prisma, {
      email: 'variants-customer@example.com',
      passwordHash,
      roleName: 'customer',
    });
    customerId = customer.id;

    // A plain customer with ONE permission granted directly. Roles cannot
    // express this — operator does not hold products.update — and the split
    // between the PATCHes and the DELETE is the thing under test.
    const editor = await createUserWithRole(prisma, {
      email: 'variants-editor@example.com',
      passwordHash,
      roleName: 'customer',
    });
    const updatePermission = await prisma.permission.findUniqueOrThrow({
      where: { key: PERMISSIONS.PRODUCTS_UPDATE },
      select: { id: true },
    });
    await prisma.userPermission.create({
      data: { userId: editor.id, permissionId: updatePermission.id },
    });

    adminToken = await login('variants-admin@example.com');
    editorToken = await login('variants-editor@example.com');
    customerToken = await login('variants-customer@example.com');
  });

  beforeEach(async () => {
    // Orders first: order_items Restrict product deletion, so the rows that
    // point at products have to go before the products do.
    await resetOrdersTables(prisma);
    await resetCatalogTables(prisma);
    resetRateLimits();
  });

  afterAll(async () => {
    await resetOrdersTables(prisma);
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

  interface Variant {
    id: string;
    label: string;
    position: number;
    stockQuantity: number;
  }

  interface Product {
    id: string;
    variants: Variant[];
  }

  /** ACTIVE from birth: cart adds refuse anything else. */
  async function createShirt(labels: string[]): Promise<Product> {
    const response = await http()
      .post('/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Camiseta Preta',
        priceCents: 4990,
        status: 'ACTIVE',
        variants: labels.map((label) => ({ label, stockQuantity: 10 })),
      })
      .expect(201);

    return response.body as Product;
  }

  function sizeOf(product: Product, label: string): string {
    const variant = product.variants.find((row) => row.label === label);
    if (!variant) {
      throw new Error(`No ${label} on this product`);
    }
    return variant.id;
  }

  /** Reads the product back the way the panel would, with products.read. */
  async function readProduct(id: string): Promise<Product> {
    const response = await http()
      .get(`/products/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    return response.body as Product;
  }

  function labelsOf(product: Product): string[] {
    return product.variants.map((variant) => variant.label);
  }

  /**
   * Puts a size in a cart over HTTP — a real cart line, made the way a
   * shopper makes one.
   */
  async function addToCart(token: string, variantId: string): Promise<void> {
    await http()
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId, quantity: 1 })
      .expect(201);
  }

  /**
   * Writes a placed order holding this size.
   *
   * Directly, rather than through checkout: what is under test is the
   * order_items row and the FK behind it, not the purchase flow that produces
   * one — and driving checkout here would drag freight quoting and Stripe into
   * a catalog test. Same seam, and the same reasoning, as createUserWithRole.
   */
  async function sellSize(
    product: Product,
    label: string,
  ): Promise<{ id: string }> {
    return prisma.order.create({
      data: {
        userId: customerId,
        itemsSubtotalCents: 4990,
        shippingCents: 0,
        totalCents: 4990,
        shippingLine1: 'Rua Um, 1',
        shippingCity: 'São Paulo',
        shippingState: 'SP',
        shippingPostalCode: '01001000',
        items: {
          create: {
            productId: product.id,
            variantId: sizeOf(product, label),
            productName: 'Camiseta Preta',
            variantLabel: label,
            unitPriceCents: 4990,
            quantity: 1,
          },
        },
      },
      select: { id: true },
    });
  }

  function countCartLines(variantId: string): Promise<number> {
    return prisma.cartItem.count({ where: { variantId } });
  }

  describe('PATCH /products/:id/variants/:variantId (rename)', () => {
    it('renames a size, leaving its position and stock alone', async () => {
      const shirt = await createShirt(['P', 'M']);

      const response = await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'Médio' })
        .expect(200);

      expect(labelsOf(response.body as Product)).toEqual(['P', 'Médio']);
      const renamed = (response.body as Product).variants[1];
      expect(renamed.position).toBe(1);
      expect(renamed.stockQuantity).toBe(10);
    });

    it('does not rewrite an order that already bought that size', async () => {
      // The whole reason renaming is safe: order_items.variant_label is a
      // snapshot taken at purchase, so history cannot be edited from here.
      const shirt = await createShirt(['P', 'M']);
      const order = await sellSize(shirt, 'M');

      await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'Médio' })
        .expect(200);

      const placed = await http()
        .get(`/orders/${order.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      expect(
        (placed.body as { items: { variantLabel: string }[] }).items[0]
          .variantLabel,
      ).toBe('M');
    });

    it('shows the new label in a cart that holds the size', async () => {
      // The deliberate opposite of the order above: a cart holds no snapshot,
      // so it reports the catalogue as it is now.
      const shirt = await createShirt(['P', 'M']);
      await addToCart(customerToken, sizeOf(shirt, 'M'));

      await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'Médio' })
        .expect(200);

      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      expect(
        (cart.body as { items: { variant: { label: string } }[] }).items[0]
          .variant.label,
      ).toBe('Médio');
    });

    it('409s a label a sibling already holds, and no-ops its own', async () => {
      const shirt = await createShirt(['P', 'M']);

      await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'P' })
        .expect(409);

      // Renaming a size to what it already is asks for nothing, and asking
      // for nothing is not a conflict.
      await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'M' })
        .expect(200);

      expect(labelsOf(await readProduct(shirt.id))).toEqual(['P', 'M']);
    });

    it('404s a variant belonging to another product, and 400s a bad label', async () => {
      const shirt = await createShirt(['P']);

      const second = await http()
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Camiseta Branca',
          priceCents: 4990,
          variants: [{ label: 'G' }],
        })
        .expect(201);
      const strangersSize = sizeOf(second.body as Product, 'G');

      // The product segment of the URL is not decoration: a real variant id
      // under the wrong product is as invisible as one that does not exist.
      await http()
        .patch(`/products/${shirt.id}/variants/${strangersSize}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'GG' })
        .expect(404);

      await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'P')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: '' })
        .expect(400);
    });
  });

  describe('PATCH /products/:id/variants/order (reorder)', () => {
    it('is not captured by the rename route', async () => {
      // The two paths have the same shape. Declared in the wrong order in the
      // controller, `order` becomes a variantId and this answers 404 — which
      // is exactly the silent breakage this test exists to catch.
      const shirt = await createShirt(['P', 'M', 'G']);

      await http()
        .patch(`/products/${shirt.id}/variants/order`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          variantIds: [
            sizeOf(shirt, 'G'),
            sizeOf(shirt, 'P'),
            sizeOf(shirt, 'M'),
          ],
        })
        .expect(200);
    });

    it('rewrites positions as the index in the list sent', async () => {
      const shirt = await createShirt(['P', 'M', 'G']);

      const response = await http()
        .patch(`/products/${shirt.id}/variants/order`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          variantIds: [
            sizeOf(shirt, 'G'),
            sizeOf(shirt, 'P'),
            sizeOf(shirt, 'M'),
          ],
        })
        .expect(200);

      expect(labelsOf(response.body as Product)).toEqual(['G', 'P', 'M']);
      expect(
        (response.body as Product).variants.map((row) => row.position),
      ).toEqual([0, 1, 2]);
      // And it stuck — the read path orders by position, not by insertion.
      expect(labelsOf(await readProduct(shirt.id))).toEqual(['G', 'P', 'M']);
    });

    it('400s a partial list and leaves the order untouched', async () => {
      const shirt = await createShirt(['P', 'M', 'G']);

      await http()
        .patch(`/products/${shirt.id}/variants/order`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ variantIds: [sizeOf(shirt, 'G'), sizeOf(shirt, 'P')] })
        .expect(400);

      expect(labelsOf(await readProduct(shirt.id))).toEqual(['P', 'M', 'G']);
    });
  });

  describe('DELETE /products/:id/variants/:variantId', () => {
    it('removes a size nobody bought and nobody is carrying', async () => {
      const shirt = await createShirt(['P', 'M']);

      const response = await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(labelsOf(response.body as Product)).toEqual(['P']);
    });

    it('refuses the last variant a product has', async () => {
      const shirt = await createShirt(['Único']);

      await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'Único')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ discardCartLines: true, expectedCartLineCount: 0 })
        .expect(409);

      // Not even with both halves of the confirmation: this wall has no door.
      expect(labelsOf(await readProduct(shirt.id))).toEqual(['Único']);
    });

    it('refuses a size that was sold, and the order survives', async () => {
      const shirt = await createShirt(['P', 'M']);
      const order = await sellSize(shirt, 'M');

      await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(labelsOf(await readProduct(shirt.id))).toEqual(['P', 'M']);
      // The order is whole — which is the point of RESTRICT. (The service
      // counts order items first, so this 409 is the pre-check's; the FK
      // behind it is pinned by the unit test for P2003.)
      await http()
        .get(`/orders/${order.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
    });

    it('409s with the cart count, and false really means false', async () => {
      const shirt = await createShirt(['P', 'M']);
      await addToCart(customerToken, sizeOf(shirt, 'M'));

      const response = await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(response.body).toEqual({
        message: expect.stringContaining('1') as string,
        cartLineCount: 1,
      });

      // The query-string boolean trap: Boolean('false') is true, so a naive
      // transform would read this as authorisation to destroy.
      await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ discardCartLines: 'false' })
        .expect(409);

      expect(await countCartLines(sizeOf(shirt, 'M'))).toBe(1);
    });

    it('removes the size and the cart line together when the impact matches', async () => {
      const shirt = await createShirt(['P', 'M']);
      await addToCart(customerToken, sizeOf(shirt, 'P'));
      await addToCart(customerToken, sizeOf(shirt, 'M'));

      await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ discardCartLines: true, expectedCartLineCount: 1 })
        .expect(200);

      expect(labelsOf(await readProduct(shirt.id))).toEqual(['P']);

      // The victim's bag: one line fewer, and the subtotal re-derived from
      // what is left rather than left stale.
      const cart = await http()
        .get('/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      const body = cart.body as {
        items: { variantId: string }[];
        itemsSubtotalCents: number;
        itemCount: number;
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].variantId).toBe(sizeOf(shirt, 'P'));
      expect(body.itemsSubtotalCents).toBe(4990);
      expect(body.itemCount).toBe(1);
    });

    it('aborts when a cart arrives between the warning and the confirmation', async () => {
      const shirt = await createShirt(['P', 'M']);
      await addToCart(customerToken, sizeOf(shirt, 'M'));

      // The operator reads the warning: one cart.
      const warning = await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect((warning.body as { cartLineCount: number }).cartLineCount).toBe(1);

      // Somebody else puts the same size in their bag while the dialog is open.
      await addToCart(editorToken, sizeOf(shirt, 'M'));

      const stale = await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ discardCartLines: true, expectedCartLineCount: 1 })
        .expect(409);

      expect((stale.body as { cartLineCount: number }).cartLineCount).toBe(2);
      // Nothing happened: not the variant, and not either cart line.
      expect(labelsOf(await readProduct(shirt.id))).toEqual(['P', 'M']);
      expect(await countCartLines(sizeOf(shirt, 'M'))).toBe(2);

      // Reviewing again is all it takes.
      await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ discardCartLines: true, expectedCartLineCount: 2 })
        .expect(200);

      expect(await countCartLines(sizeOf(shirt, 'M'))).toBe(0);
    });

    it('400s either half of the confirmation sent alone, or a bogus boolean', async () => {
      const shirt = await createShirt(['P', 'M']);
      const target = `/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`;

      await http()
        .delete(target)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ discardCartLines: true })
        .expect(400);

      await http()
        .delete(target)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ expectedCartLineCount: 0 })
        .expect(400);

      await http()
        .delete(target)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ discardCartLines: 'maybe', expectedCartLineCount: 0 })
        .expect(400);
    });
  });

  describe('authorization', () => {
    it('splits editing from destroying: products.update is not products.delete', async () => {
      const shirt = await createShirt(['P', 'M']);

      // The editor may rename and reorder…
      await http()
        .patch(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ label: 'Médio' })
        .expect(200);

      await http()
        .patch(`/products/${shirt.id}/variants/order`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ variantIds: [sizeOf(shirt, 'M'), sizeOf(shirt, 'P')] })
        .expect(200);

      // …but not discard a size, its stock, and other people's cart lines.
      await http()
        .delete(`/products/${shirt.id}/variants/${sizeOf(shirt, 'M')}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .expect(403);
    });

    it('refuses a plain customer, and anyone without a token', async () => {
      const shirt = await createShirt(['P', 'M']);
      const variant = sizeOf(shirt, 'M');

      await http()
        .patch(`/products/${shirt.id}/variants/${variant}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ label: 'Médio' })
        .expect(403);

      await http()
        .patch(`/products/${shirt.id}/variants/order`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantIds: [variant, sizeOf(shirt, 'P')] })
        .expect(403);

      await http()
        .delete(`/products/${shirt.id}/variants/${variant}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);

      await http()
        .delete(`/products/${shirt.id}/variants/${variant}`)
        .expect(401);
    });
  });
});
