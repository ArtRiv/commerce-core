import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';

export interface AmazonBuyerPii {
  buyerName: string;
  buyerEmail?: string;
  phone?: string;
  cpfCnpj?: string;
  shippingAddress: {
    recipientName: string;
    addressLine1: string;
    addressLine2?: string | null;
    street?: string;
    number?: string;
    neighborhood?: string;
    city: string;
    state: string;
    postalCode: string;
    countryCode?: string;
  };
}

export interface DppComplianceReport {
  compliant: boolean;
  dppAuditStatus: 'COMPLIANT' | 'ROTATION_REQUIRED' | 'DISCONNECTED';
  daysSinceLastRotation: number;
  maxAllowedDays: number;
  piiEncryptionAlgorithm: string;
  retentionDays: number;
}

const DPP_MAX_CREDENTIAL_AGE_DAYS = 180;
const DPP_PII_RETENTION_DAYS = 30;

/**
 * Serviço de governança e conformidade com a Data Protection Policy (DPP) da Amazon.
 *
 * Responsável por:
 * 1. Criptografia e decriptografia em repouso de dados de identificação pessoal (PII)
 *    do comprador utilizando o algoritmo autenticado AES-256-GCM.
 * 2. Purgação e anonimização de PII em pedidos cumpridos para auditoria de retenção (30 dias).
 * 3. Verificação de conformidade do ciclo de vida de credenciais (regra de rotação de 180 dias).
 */
@Injectable()
export class AmazonDppService {
  private readonly logger = new Logger(AmazonDppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Cifra o objeto contendo dados de identificação pessoal (PII) do comprador
   * utilizando AES-256-GCM em repouso.
   */
  encryptBuyerPii(pii: AmazonBuyerPii): string {
    return this.encryption.encryptJson(pii);
  }

  /**
   * Decifra o payload de PII previamente gravado no pedido.
   */
  decryptBuyerPii(encryptedPayload: string): AmazonBuyerPii {
    return this.encryption.decryptJson<AmazonBuyerPii>(encryptedPayload);
  }

  /**
   * Anonimiza a PII de um pedido da Amazon na tabela central `orders` após o prazo de retenção.
   * Substitui referências físicas por marcadores higienizados e remove o payload cifrado.
   */
  async anonymizeOrderPii(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return false;
    }

    if (order.originChannel !== 'AMAZON') {
      this.logger.warn(
        `Tentativa de higienização DPP em pedido de canal não-Amazon: ${order.originChannel}`,
      );
      return false;
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        encryptedBuyerPii: null,
        shippingLine1: '[AMAZON-PII-PURGED-DPP]',
        shippingLine2: null,
        shippingStreet: '[PURGED]',
        shippingNumber: 'S/N',
        shippingComplement: null,
        shippingNeighborhood: null,
        updatedAt: new Date(),
      },
    });

    this.logger.log(
      `Dados PII do pedido Amazon ${orderId} higienizados conforme DPP da Amazon (Retenção cumprida).`,
    );
    return true;
  }

  /**
   * Avalia a conformidade das credenciais da Amazon com os requisitos de auditoria DPP,
   * em especial a rotação mandatória a cada 180 dias.
   */
  async checkComplianceStatus(
    tenantId = 'default',
  ): Promise<DppComplianceReport> {
    const integration = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'AMAZON' } },
    });

    if (!integration || integration.status !== 'ACTIVE') {
      return {
        compliant: false,
        dppAuditStatus: 'DISCONNECTED',
        daysSinceLastRotation: 0,
        maxAllowedDays: DPP_MAX_CREDENTIAL_AGE_DAYS,
        piiEncryptionAlgorithm: 'AES-256-GCM',
        retentionDays: DPP_PII_RETENTION_DAYS,
      };
    }

    const lastRotation = integration.updatedAt;
    const diffMs = Date.now() - lastRotation.getTime();
    const daysSinceLastRotation = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    const compliant = daysSinceLastRotation <= DPP_MAX_CREDENTIAL_AGE_DAYS;

    return {
      compliant,
      dppAuditStatus: compliant ? 'COMPLIANT' : 'ROTATION_REQUIRED',
      daysSinceLastRotation,
      maxAllowedDays: DPP_MAX_CREDENTIAL_AGE_DAYS,
      piiEncryptionAlgorithm: 'AES-256-GCM',
      retentionDays: DPP_PII_RETENTION_DAYS,
    };
  }
}
