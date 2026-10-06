import { FakeShippingLabelService } from './fake-shipping-label.service';
import type { LabelPurchaseInput } from './shipping-label.service';

function createInput(
  overrides: Partial<LabelPurchaseInput> = {},
): LabelPurchaseInput {
  return {
    orderId: 'order-123',
    serviceCode: 'melhorenvio.1',
    totalWeightGrams: 500,
    heightCm: 10,
    widthCm: 15,
    lengthCm: 20,
    insuranceValueBrl: 100,
    origin: { postalCode: '01001000', name: 'Store', phone: '11999999999' },
    destination: {
      postalCode: '80000-000',
      name: 'Buyer',
      address: 'Rua Teste',
      number: '123',
      complement: '',
      neighborhood: 'Centro',
      city: 'Curitiba',
      stateAbbr: 'PR',
    },
    ...overrides,
  };
}

describe('FakeShippingLabelService', () => {
  it('generates simulated tracking code and label URL', async () => {
    const service = new FakeShippingLabelService();
    const result = await service.purchase(createInput());

    expect(result.trackingCode).toMatch(/^BR\d{9}BR$/);
    expect(result.melhorEnvioShipmentId).toBe('fake_order-123');
    expect(result.labelUrl).toContain('sandbox.melhorenvio.com.br');
  });
});
