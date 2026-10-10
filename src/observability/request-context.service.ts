import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

export interface RequestContextData {
  correlationId: string;
  tenantId?: string;
  orderId?: string;
  userId?: string;
  [key: string]: unknown;
}

/**
 * Gerenciador de contexto assíncrono baseado em AsyncLocalStorage do Node.js.
 *
 * Permite propagar metadados de execução (como tenant_id, order_id e correlation_id)
 * de ponta a ponta sem poluir assinaturas de métodos nas camadas de domínio.
 * Suporta acesso tanto via injeção de dependência NestJS quanto via métodos estáticos.
 */
@Injectable()
export class RequestContextService {
  private static readonly storage = new AsyncLocalStorage<RequestContextData>();

  /**
   * Executa uma função síncrona ou assíncrona dentro de um contexto isolado.
   */
  run<T>(context: RequestContextData, fn: () => T): T {
    return RequestContextService.storage.run(context, fn);
  }

  /**
   * Retorna o store atual da cadeia assíncrona ativa.
   */
  getStore(): RequestContextData | undefined {
    return RequestContextService.storage.getStore();
  }

  /**
   * Retorna o ID de correlação ativo.
   */
  getCorrelationId(): string | undefined {
    return this.getStore()?.correlationId;
  }

  /**
   * Retorna o tenant_id ativo.
   */
  getTenantId(): string | undefined {
    return this.getStore()?.tenantId;
  }

  /**
   * Retorna o order_id ativo.
   */
  getOrderId(): string | undefined {
    return this.getStore()?.orderId;
  }

  /**
   * Atualiza dinamicamente o tenant_id no contexto ativo.
   */
  setTenantId(tenantId?: string | null): void {
    RequestContextService.setTenantId(tenantId);
  }

  /**
   * Atualiza dinamicamente o order_id no contexto ativo.
   */
  setOrderId(orderId?: string | null): void {
    RequestContextService.setOrderId(orderId);
  }

  /**
   * Atualiza dinamicamente o userId no contexto ativo.
   */
  setUserId(userId?: string | null): void {
    RequestContextService.setUserId(userId);
  }

  /**
   * Define uma chave arbitrária no contexto ativo.
   */
  set(key: string, value: unknown): void {
    RequestContextService.set(key, value);
  }

  /**
   * Recupera uma chave arbitrária do contexto ativo.
   */
  get(key: string): unknown {
    return RequestContextService.get(key);
  }

  // --- Métodos Estáticos para Acesso Conveniente Global ---

  static getStore(): RequestContextData | undefined {
    return this.storage.getStore();
  }

  static getCorrelationId(): string | undefined {
    return this.storage.getStore()?.correlationId;
  }

  static getTenantId(): string | undefined {
    return this.storage.getStore()?.tenantId;
  }

  static getOrderId(): string | undefined {
    return this.storage.getStore()?.orderId;
  }

  static setTenantId(tenantId?: string | null): void {
    const store = this.storage.getStore();
    if (store) {
      store.tenantId = tenantId ?? undefined;
    }
  }

  static setOrderId(orderId?: string | null): void {
    const store = this.storage.getStore();
    if (store) {
      store.orderId = orderId ?? undefined;
    }
  }

  static setUserId(userId?: string | null): void {
    const store = this.storage.getStore();
    if (store) {
      store.userId = userId ?? undefined;
    }
  }

  static set(key: string, value: unknown): void {
    const store = this.storage.getStore();
    if (store) {
      store[key] = value;
    }
  }

  static get(key: string): unknown {
    return this.storage.getStore()?.[key];
  }
}
