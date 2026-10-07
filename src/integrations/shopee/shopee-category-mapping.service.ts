import { Injectable, Logger } from '@nestjs/common';

export interface ShopeeAttributeValue {
  value_id?: number;
  original_value_name: string;
}

export interface ShopeeAttribute {
  attribute_id: number;
  attribute_value_list: ShopeeAttributeValue[];
}

export interface ShopeeCategoryMappingResult {
  categoryId: number;
  categoryName: string;
  attributes: ShopeeAttribute[];
}

@Injectable()
export class ShopeeCategoryMappingService {
  private readonly logger = new Logger(ShopeeCategoryMappingService.name);

  // Mapeamento padrão de categorias de vestuário e moda para Shopee Brasil
  private readonly categoryTaxonomyMap: Record<
    string,
    { id: number; name: string }
  > = {
    camisetas: { id: 100017, name: 'Moda Masculina > Camisetas e Polos' },
    camiseta: { id: 100017, name: 'Moda Masculina > Camisetas e Polos' },
    tshirt: { id: 100017, name: 'Moda Masculina > Camisetas e Polos' },
    moletons: { id: 100021, name: 'Moda Masculina > Casacos e Moletons' },
    moletom: { id: 100021, name: 'Moda Masculina > Casacos e Moletons' },
    calcas: { id: 100030, name: 'Moda Masculina > Calças' },
    calca: { id: 100030, name: 'Moda Masculina > Calças' },
    bermudas: { id: 100032, name: 'Moda Masculina > Bermudas e Shorts' },
    acessorios: { id: 100035, name: 'Acessórios de Moda' },
    bones: { id: 100036, name: 'Acessórios de Moda > Bonés e Chapéus' },
  };

  private readonly defaultCategory = {
    id: 100017,
    name: 'Moda Masculina > Camisetas e Vestuário',
  };

  /**
   * Identifica a categoria Shopee correspondente a partir do nome ou categoria do produto local.
   */
  resolveCategory(categorySlugOrName?: string | null): {
    id: number;
    name: string;
  } {
    if (!categorySlugOrName) {
      return this.defaultCategory;
    }

    const normalized = categorySlugOrName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    for (const [key, val] of Object.entries(this.categoryTaxonomyMap)) {
      if (normalized.includes(key)) {
        return val;
      }
    }

    return this.defaultCategory;
  }

  /**
   * Gera a lista de atributos mandatários exigidos pela Shopee para a categoria mapeada.
   * Garante que produtos enviados nunca sejam recusados pela validação estrita da Shopee.
   */
  resolveMandatoryAttributes(
    categoryId: number,
    productName: string,
    brandName = 'AVESSO',
  ): ShopeeAttribute[] {
    // Atributos mandatários universais da taxonomia Shopee para Moda e Vestuário no Brasil
    const attributes: ShopeeAttribute[] = [
      {
        attribute_id: 100001, // Marca / Brand
        attribute_value_list: [
          {
            original_value_name: brandName,
          },
        ],
      },
      {
        attribute_id: 100002, // Material
        attribute_value_list: [
          {
            original_value_name: this.detectMaterial(productName),
          },
        ],
      },
      {
        attribute_id: 100003, // País de Origem
        attribute_value_list: [
          {
            original_value_name: 'Brasil',
          },
        ],
      },
      {
        attribute_id: 100004, // Tipo de Garantia
        attribute_value_list: [
          {
            original_value_name: 'Garantia do Fabricante',
          },
        ],
      },
      {
        attribute_id: 100005, // Duração da Garantia
        attribute_value_list: [
          {
            original_value_name: '30 dias',
          },
        ],
      },
    ];

    return attributes;
  }

  /**
   * Detecta o material a partir do nome/título do produto ou aplica o padrão '100% Algodão'.
   */
  private detectMaterial(productName: string): string {
    const lower = productName.toLowerCase();
    if (lower.includes('linho')) return 'Linho';
    if (lower.includes('moletom') || lower.includes('fleece'))
      return 'Algodão e Poliéster';
    if (lower.includes('dry') || lower.includes('poliester'))
      return 'Poliéster';
    if (lower.includes('jeans')) return 'Jeans 100% Algodão';
    return '100% Algodão';
  }

  /**
   * Processa o produto local e retorna a estrutura pronta para a API da Shopee.
   */
  mapProduct(
    product: {
      name: string;
      categoryName?: string | null;
      description?: string | null;
    },
    brandName = 'AVESSO',
  ): ShopeeCategoryMappingResult {
    const category = this.resolveCategory(product.categoryName || product.name);
    const attributes = this.resolveMandatoryAttributes(
      category.id,
      product.name,
      brandName,
    );

    return {
      categoryId: category.id,
      categoryName: category.name,
      attributes,
    };
  }
}
