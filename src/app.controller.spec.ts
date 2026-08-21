import { Test, TestingModule } from '@nestjs/testing';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { API_VERSION } from './openapi/document';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('reports the process as live, with the published contract version', () => {
      const health = appController.getHealth();

      expect(health.status).toBe('ok');
      expect(health.version).toBe(API_VERSION);
    });

    it('reports uptime as a whole number of seconds', () => {
      const { uptimeSeconds } = appController.getHealth();

      expect(Number.isInteger(uptimeSeconds)).toBe(true);
      expect(uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });
});
