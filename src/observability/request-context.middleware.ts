import { randomUUID } from 'node:crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { RequestContextService } from './request-context.service';

/**
 * Middleware HTTP para inicialização do AsyncLocalStorage por requisição.
 *
 * Captura ou gera o correlation_id (X-Correlation-Id / X-Request-Id),
 * extrai tenant_id (X-Tenant-Id) e order_id (X-Order-Id ou rota),
 * e propaga todo o ciclo de vida da requisição dentro do contexto do Node.js.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly contextService: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const rawCorrelationId =
      req.headers['x-correlation-id'] || req.headers['x-request-id'];
    const correlationId = Array.isArray(rawCorrelationId)
      ? rawCorrelationId[0]
      : (rawCorrelationId as string) || randomUUID();

    const rawTenantId =
      req.headers['x-tenant-id'] || (req.query.tenant_id as string | undefined);
    const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;

    const rawOrderId =
      req.headers['x-order-id'] ||
      req.params.id ||
      req.params.orderId ||
      this.extractOrderIdFromPath(req.baseUrl || req.url || req.path);
    const orderId = Array.isArray(rawOrderId) ? rawOrderId[0] : rawOrderId;

    // Garante que o header de correlação retorne ao cliente para rastreabilidade
    res.setHeader('X-Correlation-Id', correlationId);
    if (tenantId) {
      res.setHeader('X-Tenant-Id', tenantId);
    }

    this.contextService.run(
      {
        correlationId,
        tenantId,
        orderId,
        method: req.method,
        path: req.originalUrl || req.url,
      },
      () => {
        next();
      },
    );
  }

  private extractOrderIdFromPath(path?: string): string | undefined {
    if (!path) return undefined;
    // Captura UUIDs ou IDs em rotas de orders (ex: /orders/123e4567-e89b-12d3-a456-426614174000)
    const match = path.match(
      /\/orders\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
    );
    return match ? match[1] : undefined;
  }
}
