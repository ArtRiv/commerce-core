import { ShopeeCategoryMappingService } from './shopee-category-mapping.service';

describe('ShopeeCategoryMappingService', () => {
  let service: ShopeeCategoryMappingService;

  beforeEach(() => {
    service = new ShopeeCategoryMappingService();
  });

  it('resolve categoria a partir do nome ou slug de vestuário', () => {
    const camisetas = service.resolveCategory('camisetas-masculinas');
    expect(camisetas.id).toBe(100017);
    expect(camisetas.name).toContain('Camisetas');

    const moletons = service.resolveCategory('Moletons e Casacos');
    expect(moletons.id).toBe(100021);

    const bones = service.resolveCategory('bones');
    expect(bones.id).toBe(100036);

    const fallback = service.resolveCategory('Categoria Inexistente');
    expect(fallback.id).toBe(100017); // Categoria padrão
  });

  it('injeta atributos obrigatórios e mandatários exigidos pela Shopee', () => {
    const attrs = service.resolveMandatoryAttributes(
      100017,
      'Camiseta Linho Cru',
      'AVESSO',
    );

    expect(attrs).toHaveLength(5);

    // Marca
    const brandAttr = attrs.find((a) => a.attribute_id === 100001);
    expect(brandAttr).toBeDefined();
    expect(brandAttr?.attribute_value_list[0].original_value_name).toBe(
      'AVESSO',
    );

    // Material detectado
    const materialAttr = attrs.find((a) => a.attribute_id === 100002);
    expect(materialAttr).toBeDefined();
    expect(materialAttr?.attribute_value_list[0].original_value_name).toBe(
      'Linho',
    );

    // País de Origem
    const originAttr = attrs.find((a) => a.attribute_id === 100003);
    expect(originAttr?.attribute_value_list[0].original_value_name).toBe(
      'Brasil',
    );

    // Garantia
    const warrantyAttr = attrs.find((a) => a.attribute_id === 100004);
    expect(warrantyAttr?.attribute_value_list[0].original_value_name).toBe(
      'Garantia do Fabricante',
    );
  });

  it('detecta material padrão quando não houver menção no título', () => {
    const attrs = service.resolveMandatoryAttributes(
      100017,
      'Camiseta Básica Preta',
    );
    const materialAttr = attrs.find((a) => a.attribute_id === 100002);
    expect(materialAttr?.attribute_value_list[0].original_value_name).toBe(
      '100% Algodão',
    );
  });

  it('mapeia produto completo gerando categoryId e lista de atributos estruturados', () => {
    const mapped = service.mapProduct({
      name: 'Moletom Canguru Premium',
      categoryName: 'Moletons',
      description: 'Moletom 100% confortável',
    });

    expect(mapped.categoryId).toBe(100021);
    expect(mapped.categoryName).toContain('Moletons');
    expect(mapped.attributes.length).toBeGreaterThanOrEqual(4);
  });
});
