import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';

import { BEARER_SCHEME } from './security';

/**
 * Version of the published contract, not of the package.
 *
 * Kept as a constant rather than read from package.json because tsconfig does
 * not enable resolveJsonModule, and because the two answer different
 * questions: package.json versions the deployable, this versions what
 * consumers code against.
 */
export const API_VERSION = '1.0.0';

/**
 * Tags name the domain a CONSUMER sees, which is not always the folder the
 * code lives in. `POST /payments/webhook` and `POST /shipping/quote` are both
 * served from src/orders/ — reacting to a payment and quoting freight both
 * need the cart, and hosting them in their namesake module would invert the
 * dependency into a cycle (docs/architecture/modules.md). None of that is a
 * frontend's problem, so they are tagged by their URL.
 */
const TAGS: readonly { name: string; description: string }[] = [
  { name: 'health', description: 'Liveness.' },
  {
    name: 'auth',
    description:
      'Registration, e-mail verification, sign-in (password and Google), token rotation and password reset.',
  },
  {
    name: 'products',
    description:
      'The storefront catalog. Reads are public; a token carrying `products.read` additionally reveals DRAFT and ARCHIVED products.',
  },
  { name: 'categories', description: 'Flat product categories.' },
  {
    name: 'cart',
    description:
      "The caller's own cart. No cart id appears in any URL — the token decides whose cart this is.",
  },
  {
    name: 'orders',
    description:
      'Checkout and the order lifecycle: CREATED → PAID → SHIPPED → DELIVERED, plus CANCELLED and REFUNDED.',
  },
  {
    name: 'payments',
    description: 'Where the payment provider reports what happened.',
  },
  { name: 'shipping', description: 'Freight quoting.' },
  {
    name: 'reports',
    description:
      'Read-only aggregates for a back office: what sold, what it earned, what is sitting in carts, and what is not moving. Every route is gated on `reports.read`.',
  },
];

const DESCRIPTION = `
Headless e-commerce API.

### Authentication

Every route requires a bearer access token **except** those marked without a
lock — authentication is on by default (a global guard) and routes opt out
explicitly, so a route that forgets to is private rather than exposed.

Access tokens last 15 minutes and carry only the user id: roles and
permissions are resolved from the database on every request, so a permission
revoked now is revoked now, not in fifteen minutes. Trade the refresh token at
\`POST /auth/refresh\` for a fresh pair; refresh tokens are single-use, and
re-presenting a spent one revokes the whole session family as a theft signal.

### Authorization

Back-office routes are gated on a **permission**, never on a role — roles are
rows in the database that map to a set of permissions, so a route saying
"needs \`orders.refund\`" stays correct when the definition of \`admin\`
changes. Each gated route names its permission in the description of its
\`403\` response.

Out of the box: \`customer\` holds none, \`operator\` holds
\`products.read\`, \`orders.read\`, \`orders.update_status\`,
\`customers.read\`, \`coupons.read\` and \`reports.read\`, and \`admin\`
holds every permission — including \`orders.refund\`, which nothing else does.

### Errors

Failures share one body — \`{ statusCode, message, error }\` — where
\`message\` is an array of strings when a DTO fails validation and a single
string otherwise. The status codes are used consistently:

| Code | Meaning |
| ---- | ------- |
| 400 | Malformed input. |
| 401 | No token, or a token that was offered and rejected. |
| 403 | Authenticated, but lacking the permission the route names. |
| 404 | Does not exist **or belongs to someone else** — deliberately indistinguishable, so that probing ids reveals nothing. |
| 409 | A valid request that conflicts with current state (an invalid lifecycle transition, insufficient stock, a stale freight quote). |
| 429 | Rate limited. Carries \`Retry-After\`. |
| 503 | A provider this route depends on is unreachable. |

### Money

All amounts are **integer cents** of a single currency (BRL). There are no
floats anywhere in this API.
`.trim();

/**
 * Builds the OpenAPI document from the running application's metadata.
 *
 * Shared by main.ts (which serves it) and generate.ts (which writes it to
 * disk without opening a port), so the served document and the committed
 * openapi.json cannot describe different APIs.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('commerce-core')
    .setDescription(DESCRIPTION)
    .setVersion(API_VERSION)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'The `accessToken` from /auth/login, /auth/refresh or the Google callback.',
      },
      BEARER_SCHEME,
    );

  for (const tag of TAGS) {
    config.addTag(tag.name, tag.description);
  }

  return SwaggerModule.createDocument(app, config.build());
}

/** Mounts Swagger UI at /docs and the raw document at /docs-json. */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: {
      // Survives a page reload, so exploring a protected route does not mean
      // pasting a token again after every refresh.
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });
}
