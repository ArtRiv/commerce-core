import { AmazonCatalogMappingService } from './amazon-catalog-mapping.service';

describe('AmazonCatalogMappingService', () => {
  let service: AmazonCatalogMappingService;

  beforeEach(() => {
    service = new AmazonCatalogMappingService();
  });

  describe('resolveProductType', () => {
    it('deve mapear termos de camisetas para SHIRT', () => {
      expect(
        service.resolveProductType('Camisetas', 'Camiseta Oversized'),
      ).toBe('SHIRT');
      expect(service.resolveProductType('Roupas', 'Regata Streetwear')).toBe(
        'SHIRT',
      );
    });

    it('deve mapear casacos e moletons para SWEATSHIRT', () => {
      expect(service.resolveProductType('Moletons', 'Hoodie Boxy')).toBe(
        'SWEATSHIRT',
      );
      expect(service.resolveProductType('Inverno', 'Jaqueta Corta-Vento')).toBe(
        'SWEATSHIRT',
      );
    });

    it('deve mapear calças e bermudas para PANTS', () => {
      expect(service.resolveProductType('Calças', 'Calça Cargo Preta')).toBe(
        'PANTS',
      );
      expect(service.resolveProductType('Vestuário', 'Shorts Nylon')).toBe(
        'PANTS',
      );
    });

    it('deve mapear bonés e gorros para HAT', () => {
      expect(service.resolveProductType('Acessórios', 'Boné Dad Hat')).toBe(
        'HAT',
      );
      expect(service.resolveProductType(null, 'Gorro Beanie')).toBe('HAT');
    });

    it('deve utilizar fallback CLOTHING para categorias genéricas', () => {
      expect(service.resolveProductType('Outros', 'Item Streetwear')).toBe(
        'CLOTHING',
      );
    });
  });

  describe('extractColorAndSize', () => {
    it('deve extrair cor e tamanho com barra', () => {
      const res = service.extractColorAndSize('Preto / G');
      expect(res).toEqual({ color: 'Preto', size: 'G' });
    });

    it('deve identificar tamanho isolado', () => {
      const res = service.extractColorAndSize('GG');
      expect(res).toEqual({ color: 'Única', size: 'GG' });
    });
  });

  describe('buildListingPayload', () => {
    it('deve construir payload válido para a Listings Items API v2021-08-01', () => {
      const payload = service.buildListingPayload({
        sku: 'AVESSO-CAM-OVER-BLK-G',
        title: 'Camiseta Oversized Preta',
        categoryName: 'Camisetas',
        variantLabel: 'Preto / G',
        priceCents: 18990,
        stockQuantity: 15,
        description: 'Camiseta 100% algodão penteado 260g/m².',
      });

      expect(payload.productType).toBe('SHIRT');
      expect(payload.requirements).toBe('LISTING');
      expect(payload.attributes.item_name[0]).toEqual({
        value: 'Camiseta Oversized Preta - Preto / G',
        marketplace_id: 'A2Q3Y263D00KWC',
      });
      expect(payload.attributes.brand[0]).toEqual({
        value: 'AVESSO',
        marketplace_id: 'A2Q3Y263D00KWC',
      });
      expect(payload.attributes.color[0]).toEqual({
        value: 'Preto',
        marketplace_id: 'A2Q3Y263D00KWC',
      });
      expect(payload.attributes.size[0]).toEqual({
        value: 'G',
        marketplace_id: 'A2Q3Y263D00KWC',
      });
      expect(payload.attributes.fulfillment_availability[0]).toEqual({
        fulfillment_channel_code: 'DEFAULT',
        quantity: 15,
      });
      expect(payload.attributes.purchasable_offer[0]).toEqual({
        currency: 'BRL',
        our_price: [
          {
            schedule: [{ value_with_tax: 189.9 }],
          },
        ],
      });
    });
  });

  describe('buildStockAndPricePatches', () => {
    it('deve gerar patches JSON para atualização atômica de estoque e preço', () => {
      const patches = service.buildStockAndPricePatches(8, 17990);

      expect(patches).toHaveLength(2);
      expect(patches[0]).toEqual({
        op: 'replace',
        path: '/attributes/fulfillment_availability',
        value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 8 }],
      });
      expect(patches[1]).toEqual({
        op: 'replace',
        path: '/attributes/purchasable_offer',
        value: [
          {
            currency: 'BRL',
            our_price: [{ schedule: [{ value_with_tax: 179.9 }] }],
          },
        ],
      });
    });
  });
});
