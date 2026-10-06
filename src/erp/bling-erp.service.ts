import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  CanonicalOrder,
  ErpExportResult,
  ErpService,
} from './erp-service';

/**
 * Bling API v3 base URL.
 * Sandbox (if Bling provides one): override via BLING_BASE_URL env var.
 */
const BLING_BASE_URL = 'https://www.bling.com.br/Api/v3';

/**
 * Bling ERP integration adapter.
 *
 * Creates a "pedido de venda" (sales order) in Bling ERP v3 when an order is
 * confirmed as paid. Bling then runs its internal NF-e automation workflow —
 * the platform does not issue the fiscal document directly.
 *
 * Authentication: Bling API v3 uses OAuth 2.0 Authorization Code flow. For
 * the single-tenant use case, we store a long-lived API key (generated in the
 * Bling dashboard under Configurações → API) and pass it as a Bearer token.
 * Multi-tenant OAuth per merchant is a future milestone.
 *
 * Rate limit: Bling imposes ~3 req/s per application. A single exportOrder
 * call makes one POST, well within the limit. In high-throughput scenarios
 * a token-bucket queue should sit in front of this service.
 */
@Injectable()
export class BlingErpService implements ErpService {
  private readonly logger = new Logger(BlingErpService.name);
  private readonly apiKey: string;
  private readonly storeId: string | undefined;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.apiKey = config.getOrThrow<string>('BLING_API_KEY');
    this.storeId = config.get<string>('BLING_STORE_ID')?.trim();
    this.baseUrl =
      config.get<string>('BLING_BASE_URL')?.trim() ?? BLING_BASE_URL;
  }

  async exportOrder(order: CanonicalOrder): Promise<ErpExportResult> {
    const payload = this.buildPayload(order);

    let data: { data?: { id?: number } };
    try {
      const response = await fetch(`${this.baseUrl}/pedidos/vendas`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '(unreadable)');
        this.logger.error(
          `Bling exportOrder falhou: HTTP ${String(response.status)} — ${text} (pedido ${order.id})`,
        );
        throw new Error(`Bling API: HTTP ${String(response.status)}`);
      }

      data = (await response.json()) as { data?: { id?: number } };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Bling API:')) {
        throw error;
      }
      this.logger.error(
        `Bling exportOrder erro de rede: ${String(error)} (pedido ${order.id})`,
      );
      throw new Error(`Bling API: network error — ${String(error)}`);
    }

    const blingId = data.data?.id;
    if (!blingId) {
      throw new Error(
        `Bling API não retornou ID para o pedido ${order.id}. Resposta: ${JSON.stringify(data)}`,
      );
    }

    this.logger.log(
      `Pedido ${order.id} exportado para o Bling com sucesso (Bling ID: ${String(blingId)}).`,
    );

    return { erpOrderId: String(blingId) };
  }

  // ---------------------------------------------------------------------------
  // Private: canonical → Bling payload mapping
  // ---------------------------------------------------------------------------

  private buildPayload(order: CanonicalOrder): Record<string, unknown> {
    const buyer = order.buyer;
    const address = order.address;

    const base: Record<string, unknown> = {
      // Bling field: external order reference for traceability.
      numeroPedidoCompra: order.id,

      // Situação 6 = "Em aberto" — awaiting picking/packing.
      situacao: { id: 6 },

      // Date the payment was confirmed (ISO date string).
      data: (order.paidAt ?? new Date()).toISOString().slice(0, 10),

      // Monetary values in BRL (Bling uses decimal, not cents).
      desconto: { tipo: 0, valor: 0 },
      outrasDespesas: 0,
      observacoes: `Pedido Avesso Store #${order.id}`,
      observacoesInternas: `Frete: ${order.shippingMethodName ?? 'N/A'} | CEP: ${address.postalCode}`,

      contato: {
        nome: buyer.name ?? buyer.email,
        email: buyer.email,
        tipoPessoa: 'F', // Física — simplified for v1; CNPJ detection is future.
        endereco: {
          endereco: address.street ?? '',
          numero: address.number ?? 'S/N',
          complemento: address.complement ?? '',
          bairro: address.neighborhood ?? '',
          cep: address.postalCode.replace(/\D/g, ''),
          municipio: address.city,
          uf: address.state,
          pais: 'Brasil',
        },
      },

      itens: order.items.map((item) => ({
        produto: {
          codigo: item.variantId,
          descricao: `${item.productName} — ${item.variantLabel}`,
        },
        quantidade: item.quantity,
        valor: item.unitPriceCents / 100,
      })),

      transporte: {
        fretePorConta: 0, // 0 = Emitente (loja paga o frete na etiqueta).
        frete: order.shippingCents / 100,
      },
    };

    if (this.storeId) {
      base['loja'] = { id: Number(this.storeId) };
    }

    return base;
  }
}
