import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { buildOpenApiDocument } from './document';

const OUTPUT = resolve(__dirname, '..', '..', '..', 'openapi.json');

/**
 * Writes openapi.json — the artefact the frontend project generates its client
 * from — without opening a port.
 *
 * Two things make this runnable with no infrastructure. `preview: true` builds
 * the module graph and registers controllers but instantiates no provider and
 * fires no lifecycle hook, so PrismaService never reaches its $connect and
 * ResendMailService never demands an API key. And it runs from `dist`, not
 * through a TS runner: tsx compiles with esbuild, which cannot emit
 * `design:paramtypes`, and Nest's injector needs that metadata to resolve a
 * graph even when it is not going to instantiate it. Swagger only ever reads
 * decorator metadata off controller classes, so an uninstantiated graph
 * describes exactly the same API a running one would.
 */
async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });

  try {
    const document = buildOpenApiDocument(app);

    writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    const operations = Object.values(document.paths).reduce(
      (total, path) => total + Object.keys(path).length,
      0,
    );

    console.log(`Wrote ${OUTPUT} — ${String(operations)} operations.`);
  } finally {
    await app.close();
  }
}

generate().catch((error: unknown) => {
  console.error('Failed to generate the OpenAPI document', error);
  process.exit(1);
});
