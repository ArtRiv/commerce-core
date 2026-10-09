import type { Request, Response } from 'express';

import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';

describe('RequestContextMiddleware', () => {
  let contextService: RequestContextService;
  let middleware: RequestContextMiddleware;

  beforeEach(() => {
    contextService = new RequestContextService();
    middleware = new RequestContextMiddleware(contextService);
  });

  it('deve reutilizar correlation-id fornecido nos headers e repassar na resposta', () => {
    const req = {
      headers: { 'x-correlation-id': 'custom-trace-id-123' },
      query: {},
      params: {},
      url: '/catalog/products',
      method: 'GET',
    } as unknown as Request;

    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;

    const next = jest.fn(() => {
      expect(contextService.getCorrelationId()).toBe('custom-trace-id-123');
    });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith(
      'X-Correlation-Id',
      'custom-trace-id-123',
    );
  });

  it('deve gerar novo UUID quando não houver header de correlation-id', () => {
    const req = {
      headers: {},
      query: {},
      params: {},
      url: '/auth/login',
      method: 'POST',
    } as unknown as Request;

    let generatedCid = '';
    const setHeader = jest.fn((name: string, value: string) => {
      if (name === 'X-Correlation-Id') generatedCid = value;
    });
    const res = { setHeader } as unknown as Response;

    const next = jest.fn(() => {
      expect(contextService.getCorrelationId()).toBe(generatedCid);
      expect(generatedCid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Correlation-Id', generatedCid);
  });

  it('deve extrair tenant_id e order_id dos headers e configurar no contexto', () => {
    const req = {
      headers: {
        'x-tenant-id': 'tenant-brasil',
        'x-order-id': 'order-12345',
      },
      query: {},
      params: {},
      url: '/orders/checkout',
      method: 'POST',
    } as unknown as Request;

    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;

    const next = jest.fn(() => {
      expect(contextService.getTenantId()).toBe('tenant-brasil');
      expect(contextService.getOrderId()).toBe('order-12345');
    });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Tenant-Id', 'tenant-brasil');
  });

  it('deve extrair order_id da URL quando corresponder ao padrão /orders/:uuid', () => {
    const orderUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const req = {
      headers: {},
      query: {},
      params: {},
      url: `/orders/${orderUuid}`,
      method: 'GET',
    } as unknown as Request;

    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;

    const next = jest.fn(() => {
      expect(contextService.getOrderId()).toBe(orderUuid);
    });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
