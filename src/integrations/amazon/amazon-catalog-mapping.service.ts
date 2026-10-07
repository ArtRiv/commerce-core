import { Injectable } from '@nestjs/common';

export interface AmazonListingBuildInput {
  sku: string;
  title: string;
  brand?: string;
  categoryName?: string | null;
  variantLabel: string;
  priceCents: number;
  stockQuantity: number;
  description?: string;
  marketplaceId?: string;
}

export interface AmazonListingsItemPayload {
  productType: string;
  requirements: string;
  attributes: Record<string, unknown[]>;
}

export const AMAZON_BR_MARKETPLACE_ID = 'A2Q3Y263D00KWC';

/**
 * Serviço de mapeamento da taxonomia de vestuário e atributos para a
 * Product Type Definitions API e Listings Items API v2021-08-01 da Amazon.
 */
@Injectable()
export class AmazonCatalogMappingService {
  /**
   * Identifica o Product Type padrão da Amazon a partir do nome da categoria
   * ou do título do produto.
   */
  resolveProductType(categoryName?: string | null, title?: string): string {
    const text = `${categoryName ?? ''} ${title ?? ''}`.toLowerCase();

    if (
      text.includes('camiseta') ||
      text.includes('t-shirt') ||
      text.includes('camisa') ||
      text.includes('regata')
    ) {
      return 'SHIRT';
    }

    if (
      text.includes('moletom') ||
      text.includes('hoodie') ||
      text.includes('casaco') ||
      text.includes('jaqueta')
    ) {
      return 'SWEATSHIRT';
    }

    if (
      text.includes('calça') ||
      text.includes('calca') ||
      text.includes('shorts') ||
      text.includes('bermuda')
    ) {
      return 'PANTS';
    }

    if (
      text.includes('boné') ||
      text.includes('bone') ||
      text.includes('gorro')
    ) {
      return 'HAT';
    }

    return 'CLOTHING';
  }

  /**
   * Extrai atributos visuais (tamanho e cor) a partir do label da variante.
   * Ex: "Preto / G" -> { color: "Preto", size: "G" }
   * Ex: "Tamanho M" -> { color: "Preto", size: "M" }
   */
  extractColorAndSize(variantLabel: string): { color: string; size: string } {
    const clean = variantLabel.trim();
    if (clean.includes('/')) {
      const parts = clean.split('/').map((s) => s.trim());
      return {
        color: parts[0] || 'Preto',
        size: parts[1] || 'M',
      };
    }

    // Padrão tamanho isolado (P, M, G, GG, XG, 38, 40, etc.)
    const sizeMatch = /\b(PP|P|M|G|GG|XG|XGG|\d{2})\b/i.exec(clean);
    if (sizeMatch) {
      return {
        color: 'Única',
        size: sizeMatch[1].toUpperCase(),
      };
    }

    return {
      color: 'Única',
      size: clean || 'M',
    };
  }

  /**
   * Constrói o documento de atributos formatado segundo a especificação JSON Schema
   * da Listings Items API v2021-08-01 da Amazon.
   */
  buildListingPayload(
    input: AmazonListingBuildInput,
  ): AmazonListingsItemPayload {
    const marketplaceId = input.marketplaceId ?? AMAZON_BR_MARKETPLACE_ID;
    const productType = this.resolveProductType(
      input.categoryName,
      input.title,
    );
    const { color, size } = this.extractColorAndSize(input.variantLabel);

    const priceDecimal = Number((input.priceCents / 100).toFixed(2));

    const attributes: Record<string, unknown[]> = {
      item_name: [
        {
          value: `${input.title} - ${input.variantLabel}`.trim(),
          marketplace_id: marketplaceId,
        },
      ],
      brand: [
        {
          value: input.brand ?? 'AVESSO',
          marketplace_id: marketplaceId,
        },
      ],
      color: [
        {
          value: color,
          marketplace_id: marketplaceId,
        },
      ],
      size: [
        {
          value: size,
          marketplace_id: marketplaceId,
        },
      ],
      condition_type: [
        {
          value: 'new_new',
          marketplace_id: marketplaceId,
        },
      ],
      fulfillment_availability: [
        {
          fulfillment_channel_code: 'DEFAULT',
          quantity: Math.max(0, input.stockQuantity),
        },
      ],
      purchasable_offer: [
        {
          currency: 'BRL',
          our_price: [
            {
              schedule: [
                {
                  value_with_tax: priceDecimal,
                },
              ],
            },
          ],
        },
      ],
    };

    if (input.description) {
      attributes['bullet_point'] = [
        {
          value: input.description.slice(0, 500),
          marketplace_id: marketplaceId,
        },
      ];
    }

    return {
      productType,
      requirements: 'LISTING',
      attributes,
    };
  }

  /**
   * Gera os patches JSON para atualização atômica de saldo e preço via PATCH
   * na Listings Items API.
   */
  buildStockAndPricePatches(
    stockQuantity: number,
    priceCents?: number,
  ): Array<{ op: string; path: string; value: unknown[] }> {
    const patches: Array<{ op: string; path: string; value: unknown[] }> = [
      {
        op: 'replace',
        path: '/attributes/fulfillment_availability',
        value: [
          {
            fulfillment_channel_code: 'DEFAULT',
            quantity: Math.max(0, stockQuantity),
          },
        ],
      },
    ];

    if (typeof priceCents === 'number') {
      const priceDecimal = Number((priceCents / 100).toFixed(2));
      patches.push({
        op: 'replace',
        path: '/attributes/purchasable_offer',
        value: [
          {
            currency: 'BRL',
            our_price: [
              {
                schedule: [
                  {
                    value_with_tax: priceDecimal,
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    return patches;
  }
}
