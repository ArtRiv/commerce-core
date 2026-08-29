import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import type {
  OpenAPIObject,
  OperationObject,
  PathItemObject,
} from '@nestjs/swagger';

import { AppController } from '../app.controller';
import { AppModule } from '../app.module';
import { AuthController } from '../auth/auth.controller';
import { PERMISSIONS_KEY } from '../auth/authz/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { CategoriesController } from '../catalog/categories.controller';
import { ProductsController } from '../catalog/products.controller';
import { CartController } from '../orders/cart.controller';
import { OrdersController } from '../orders/orders.controller';
import { PaymentWebhookController } from '../orders/payment-webhook.controller';
import { ShippingQuoteController } from '../orders/shipping-quote.controller';
import { ReportsController } from '../reports/reports.controller';
import { buildOpenApiDocument } from './document';

/**
 * Every controller in the application. The route count below is what keeps
 * this list honest: add a tenth controller without listing it here and the
 * totals stop matching, which fails with a message naming the gap rather than
 * quietly checking seven eighths of the API.
 */
const CONTROLLERS = [
  AppController,
  AuthController,
  ProductsController,
  CategoriesController,
  CartController,
  OrdersController,
  PaymentWebhookController,
  ShippingQuoteController,
  ReportsController,
];

/**
 * The audited size of the v1 surface (docs/specs/openapi.md).
 *
 * 39 since product variants: `PATCH /products/{id}/stock` became
 * `PATCH /products/{id}/variants/{variantId}/stock` (net zero) and
 * `POST /products/{id}/variants` arrived (net one).
 *
 * 42 since variant management: renaming, reordering and removing a variant
 * (docs/specs/variant-management.md).
 *
 * 46 since reports: the four questions a back office asks, and the ninth
 * controller (docs/specs/reports.md).
 */
const EXPECTED_ROUTE_COUNT = 46;

const HTTP_METHOD = new Map<RequestMethod, string>([
  [RequestMethod.GET, 'get'],
  [RequestMethod.POST, 'post'],
  [RequestMethod.PUT, 'put'],
  [RequestMethod.DELETE, 'delete'],
  [RequestMethod.PATCH, 'patch'],
]);

interface Route {
  /** e.g. "POST /orders/{id}/refund" — how failures identify themselves. */
  label: string;
  path: string;
  method: string;
  isPublic: boolean;
  permissions: string[];
}

/** Nest writes ':id'; OpenAPI wants '{id}'. */
function toOpenApiPath(prefix: string, suffix: string): string {
  const segments = [prefix, suffix]
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment.startsWith(':') ? `{${segment.slice(1)}}` : segment,
    );

  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * Reads the routes back off the controllers the same way Nest does — from the
 * decorator metadata — rather than from a hand-written list. A list would
 * drift from the code exactly the way this test exists to prevent.
 */
function collectRoutes(): Route[] {
  const routes: Route[] = [];

  for (const controller of CONTROLLERS) {
    const prefix = (Reflect.getMetadata(PATH_METADATA, controller) ??
      '') as string;
    const proto = controller.prototype as unknown as Record<string, unknown>;

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;

      const handler = proto[name];
      if (typeof handler !== 'function') continue;

      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (verb === undefined) continue;

      const method = HTTP_METHOD.get(verb);
      if (!method) continue;

      const suffix = (Reflect.getMetadata(PATH_METADATA, handler) ??
        '') as string;
      const path = toOpenApiPath(prefix, suffix);

      routes.push({
        label: `${method.toUpperCase()} ${path}`,
        path,
        method,
        // Exactly what JwtAuthGuard reads to decide whether to demand a token.
        isPublic:
          Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
          Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true,
        // Exactly what PermissionsGuard reads to decide whether to allow.
        permissions: (Reflect.getMetadata(PERMISSIONS_KEY, handler) ??
          Reflect.getMetadata(PERMISSIONS_KEY, controller) ??
          []) as string[],
      });
    }
  }

  return routes;
}

/**
 * Asserts that the published document says what the guards actually do.
 *
 * The guards are the source of truth, not this file: authentication is a
 * global JwtAuthGuard with an @Public() opt-out, and authorization is
 * PermissionsGuard reading @RequirePermissions. Both are read here through
 * the same metadata keys those guards use, so a route whose protection
 * changes and whose documentation does not is a failure rather than a
 * discrepancy nobody notices until a frontend trusts it.
 */
describe('OpenAPI document', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  let routes: Route[];

  const operationFor = (route: Route): OperationObject => {
    // Cast rather than annotated: the index signature on `paths` claims every
    // key resolves, and the whole point here is to catch the key that does not.
    const pathItem = document.paths[route.path] as PathItemObject | undefined;
    const operation = pathItem?.[route.method as 'get'];

    if (!operation) {
      throw new Error(`${route.label} is missing from the OpenAPI document`);
    }

    return operation;
  };

  beforeAll(async () => {
    // preview: true builds the module graph and registers controllers without
    // instantiating a single provider, so this needs no database, no mail key
    // and no Stripe key — see src/openapi/generate.ts.
    app = await NestFactory.create(AppModule, { preview: true, logger: false });
    document = buildOpenApiDocument(app);
    routes = collectRoutes();
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every route in the application, and nothing else', () => {
    const documented = Object.values(document.paths).flatMap((item) =>
      Object.keys(item),
    );

    expect(routes).toHaveLength(EXPECTED_ROUTE_COUNT);
    expect(documented).toHaveLength(EXPECTED_ROUTE_COUNT);

    // Named rather than counted, so a failure says which route went missing.
    for (const route of routes) {
      expect(() => operationFor(route)).not.toThrow();
    }
  });

  it('requires a bearer token on exactly the routes the guard protects', () => {
    const shouldRequireAuth = routes
      .filter((route) => !route.isPublic)
      .map((route) => route.label)
      .sort();

    const documentsAuth = routes
      .filter((route) => (operationFor(route).security?.length ?? 0) > 0)
      .map((route) => route.label)
      .sort();

    // Both directions matter. A protected route missing its bearer tells a
    // consumer they can call it anonymously; a public route declaring one
    // sends them hunting for a token they do not need.
    expect(documentsAuth).toEqual(shouldRequireAuth);
  });

  it('names the required permission in the 403 of every gated route', () => {
    const gated = routes.filter((route) => route.permissions.length > 0);

    expect(gated.length).toBeGreaterThan(0);

    for (const route of gated) {
      const forbidden = operationFor(route).responses['403'];

      if (!forbidden || !('description' in forbidden)) {
        throw new Error(
          `${route.label} is permission-gated but documents no 403`,
        );
      }

      for (const permission of route.permissions) {
        expect(forbidden.description).toContain(permission);
      }
    }
  });

  it('gives every operation a summary', () => {
    const unsummarised = routes
      .filter((route) => !operationFor(route).summary)
      .map((route) => route.label);

    expect(unsummarised).toEqual([]);
  });

  it('invents no request schema for the signature-verified webhook', () => {
    const webhook = operationFor({
      label: 'POST /payments/webhook',
      path: '/payments/webhook',
      method: 'post',
      isPublic: true,
      permissions: [],
    });

    const body = webhook.requestBody;

    if (!body || !('content' in body)) {
      throw new Error(
        'The webhook should document a body, opaque though it is',
      );
    }

    // Opaque on purpose: the payload belongs to the provider, and the only
    // part this API authenticates is the header (docs/specs/openapi.md).
    expect(body.content['application/json'].schema).toEqual({
      type: 'string',
      format: 'binary',
    });

    expect(webhook.parameters).toContainEqual(
      expect.objectContaining({ name: 'stripe-signature', in: 'header' }),
    );
  });

  it('leaks no secret-bearing field into the published contract', () => {
    const serialised = JSON.stringify(document);

    for (const field of ['passwordHash', 'tokenHash']) {
      expect(serialised).not.toContain(field);
    }
  });
});
