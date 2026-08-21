import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { API_VERSION } from '../src/openapi/document';
import { createTestApp } from './support/app';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  it('GET / answers the liveness probe without a token', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      version: API_VERSION,
      uptimeSeconds: expect.any(Number) as number,
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
