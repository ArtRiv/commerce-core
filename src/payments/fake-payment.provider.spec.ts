import { FakePaymentProvider } from './fake-payment.provider';

describe('FakePaymentProvider', () => {
  it('acknowledges every payment with a unique fake reference', async () => {
    const provider = new FakePaymentProvider();

    const first = await provider.createPayment();
    const second = await provider.createPayment();

    expect(first.providerRef).toMatch(/^fake_/);
    expect(second.providerRef).toMatch(/^fake_/);
    // Unique per call: paymentRef distinguishes orders, so a constant would
    // silently break any future reconciliation-by-reference.
    expect(first.providerRef).not.toBe(second.providerRef);
  });
});
