import type { OrderEmailData, OrderShippedEmailData } from './mail.service';
import {
  formatBRL,
  orderCancelledEmail,
  orderPaidEmail,
  orderRefundedEmail,
  orderShippedEmail,
} from './order-email-templates';

const ORDER_URL = 'https://loja.example.com/orders/order-1';

const BASE: OrderEmailData = {
  orderId: 'a1b2c3d4-5678-4abc-9def-000000000001',
  customerName: 'Ana',
  items: [
    { productName: 'Camiseta Azul', unitPriceCents: 4990, quantity: 2 },
    { productName: 'Caneca', unitPriceCents: 2500, quantity: 1 },
  ],
  itemsSubtotalCents: 12480,
  freight: { cents: 2490, methodName: 'Entrega padrão', etaDays: 5 },
  totalCents: 14970,
  address: {
    line1: 'Rua das Flores, 123',
    line2: null,
    city: 'Curitiba',
    state: 'PR',
    postalCode: '80000-000',
  },
};

/** An order from before the shipping module: backfilled 0, unknown method. */
const LEGACY: OrderEmailData = {
  ...BASE,
  itemsSubtotalCents: 12480,
  freight: null,
  totalCents: 12480,
};

const SHIPPED: OrderShippedEmailData = {
  ...BASE,
  trackingCode: 'BR123456789BR',
  trackingUrl: 'https://rastreio.example.com/BR123456789BR',
};

describe('formatBRL', () => {
  it.each([
    [0, 'R$ 0,00'],
    [5, 'R$ 0,05'],
    [99, 'R$ 0,99'],
    [4990, 'R$ 49,90'],
    [100000, 'R$ 1.000,00'],
    [123456789, 'R$ 1.234.567,89'],
  ])('renders %i cents as %s', (cents, expected) => {
    expect(formatBRL(cents)).toBe(expected);
  });
});

describe('orderPaidEmail', () => {
  it('breaks the money into subtotal, freight and total', () => {
    const { html } = orderPaidEmail(BASE, ORDER_URL);

    expect(html).toContain('R$ 124,80');
    expect(html).toContain('R$ 24,90');
    expect(html).toContain('R$ 149,70');
    // The method name, not just the number: "R$ 24,90" alone is neither
    // auditable nor displayable (docs/specs/shipping.md).
    expect(html).toContain('Entrega padrão');
  });

  it('states the delivery estimate that came with the method', () => {
    expect(orderPaidEmail(BASE, ORDER_URL).html).toContain('5 dias úteis');
  });

  it('omits the estimate when the method did not promise one', () => {
    const { html } = orderPaidEmail(
      {
        ...BASE,
        freight: { cents: 2490, methodName: 'Retirada', etaDays: null },
      },
      ORDER_URL,
    );

    expect(html).toContain('Retirada');
    expect(html).not.toContain('dias úteis');
  });

  it('lists every item with its quantity and line total', () => {
    const { html } = orderPaidEmail(BASE, ORDER_URL);

    expect(html).toContain('Camiseta Azul');
    expect(html).toContain('R$ 99,80');
    expect(html).toContain('Caneca');
    expect(html).toContain('R$ 25,00');
  });

  it('links to the order', () => {
    expect(orderPaidEmail(BASE, ORDER_URL).html).toContain(
      `href="${ORDER_URL}"`,
    );
  });

  it('prints the delivery address, skipping an absent complement', () => {
    const { html } = orderPaidEmail(BASE, ORDER_URL);

    expect(html).toContain('Rua das Flores, 123');
    expect(html).toContain('Curitiba');
    expect(html).toContain('80000-000');
    expect(html).not.toContain('null');
  });

  it('prints the complement when there is one', () => {
    const { html } = orderPaidEmail(
      { ...BASE, address: { ...BASE.address, line2: 'Apto 42' } },
      ORDER_URL,
    );

    expect(html).toContain('Apto 42');
  });

  describe('an order created before the shipping module existed', () => {
    it('shows no freight line at all', () => {
      const { html } = orderPaidEmail(LEGACY, ORDER_URL);

      expect(html).not.toContain('Frete');
      // The whole failure this guards: shippingCents is a backfilled zero and
      // the method is unknown, so both halves would be inventions.
      expect(html).not.toContain('R$ 0,00');
      expect(html).not.toContain('null');
    });

    it('shows no items subtotal either, since it equals the total', () => {
      const { html } = orderPaidEmail(LEGACY, ORDER_URL);

      expect(html).not.toContain('Subtotal');
      expect(html).toContain('R$ 124,80');
    });
  });

  describe('free shipping', () => {
    const free: OrderEmailData = {
      ...BASE,
      freight: { cents: 0, methodName: 'Entrega padrão', etaDays: 5 },
      totalCents: 12480,
    };

    it('says free rather than printing zero', () => {
      const { html } = orderPaidEmail(free, ORDER_URL);

      expect(html).toContain('grátis');
      expect(html).not.toContain('R$ 0,00');
    });

    it('still names the method, so it is not mistaken for a legacy order', () => {
      const { html } = orderPaidEmail(free, ORDER_URL);

      expect(html).toContain('Frete');
      expect(html).toContain('Entrega padrão');
    });
  });

  it('greets a customer who never gave a name without saying null', () => {
    const { html } = orderPaidEmail({ ...BASE, customerName: null }, ORDER_URL);

    expect(html).toContain('Olá');
    expect(html).not.toContain('null');
  });

  it('escapes text that came out of the database', () => {
    const { html } = orderPaidEmail(
      {
        ...BASE,
        customerName: '<script>alert(1)</script>',
        items: [
          {
            productName: 'Camiseta "Azul" & <b>grande</b>',
            unitPriceCents: 4990,
            quantity: 1,
          },
        ],
      },
      ORDER_URL,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;b&gt;grande&lt;/b&gt;');
  });

  it('identifies the order in the subject', () => {
    expect(orderPaidEmail(BASE, ORDER_URL).subject).toContain('a1b2c3d4');
  });
});

describe('orderShippedEmail', () => {
  it('offers the tracking code as a link when both halves are known', () => {
    const { html } = orderShippedEmail(SHIPPED, ORDER_URL);

    expect(html).toContain('BR123456789BR');
    expect(html).toContain(`href="${SHIPPED.trackingUrl ?? ''}"`);
  });

  it('prints the code as plain text when there is no URL for it', () => {
    const { html } = orderShippedEmail(
      { ...SHIPPED, trackingUrl: null },
      ORDER_URL,
    );

    expect(html).toContain('BR123456789BR');
    expect(html).not.toContain('href="https://rastreio.example.com');
  });

  it('links the carrier page when only the URL is known', () => {
    const { html } = orderShippedEmail(
      { ...SHIPPED, trackingCode: null },
      ORDER_URL,
    );

    expect(html).toContain(`href="${SHIPPED.trackingUrl ?? ''}"`);
    expect(html).not.toContain('null');
  });

  describe('a shipment with no tracking at all', () => {
    const untracked: OrderShippedEmailData = {
      ...SHIPPED,
      trackingCode: null,
      trackingUrl: null,
    };

    it('still reads as a shipment notice', () => {
      const { html } = orderShippedEmail(untracked, ORDER_URL);

      expect(html).toContain('caminho');
      expect(html).toContain('Rua das Flores, 123');
    });

    it('prints no empty tracking label', () => {
      const { html } = orderShippedEmail(untracked, ORDER_URL);

      expect(html).not.toContain('rastreio');
      expect(html).not.toContain('null');
    });
  });

  it('escapes a tracking code that came from a request body', () => {
    const { html } = orderShippedEmail(
      {
        ...SHIPPED,
        trackingCode: '"><script>alert(1)</script>',
        trackingUrl: null,
      },
      ORDER_URL,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('orderRefundedEmail', () => {
  it('states the amount that went back', () => {
    const { html } = orderRefundedEmail(BASE, ORDER_URL);

    expect(html).toContain('R$ 149,70');
  });

  it('identifies the order in the subject', () => {
    expect(orderRefundedEmail(BASE, ORDER_URL).subject).toContain('a1b2c3d4');
  });

  it('survives a legacy order without inventing freight', () => {
    const { html } = orderRefundedEmail(LEGACY, ORDER_URL);

    expect(html).toContain('R$ 124,80');
    expect(html).not.toContain('null');
  });
});

describe('orderCancelledEmail', () => {
  it('says the order was cancelled and names it', () => {
    const { subject, html } = orderCancelledEmail(BASE, ORDER_URL);

    expect(subject).toContain('cancelado');
    expect(subject).toContain('a1b2c3d4');
    expect(html).toContain('cancelado');
  });

  it('does not thank anyone for a purchase that is not happening', () => {
    const { html } = orderCancelledEmail(BASE, ORDER_URL);

    expect(html).not.toContain('Obrigado pela compra');
  });

  it('survives a legacy order without inventing freight', () => {
    expect(orderCancelledEmail(LEGACY, ORDER_URL).html).not.toContain('null');
  });
});
