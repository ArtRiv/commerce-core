import type {
  OrderEmailAddress,
  OrderEmailData,
  OrderEmailFreight,
  OrderEmailItem,
  OrderShippedEmailData,
} from './mail.service';

export interface RenderedEmail {
  subject: string;
  html: string;
}

/**
 * Cents to "R$ 1.234,56".
 *
 * Hand-rolled rather than Intl.NumberFormat because the output of these
 * templates is asserted character by character: Intl puts a non-breaking space
 * after "R$" and its grouping has changed between ICU versions, so the tests
 * would be pinned to whatever ICU the machine happens to ship.
 */
export function formatBRL(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.trunc(cents));
  const units = String(Math.trunc(absolute / 100)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    '.',
  );
  const decimals = String(absolute % 100).padStart(2, '0');

  return `${negative ? '-' : ''}R$ ${units},${decimals}`;
}

/**
 * Everything interpolated below came out of the database or a request body —
 * product names, the customer's name, an address, a tracking code an operator
 * typed. None of it is trusted markup, and an email client renders HTML.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The short form of the order id, for a human to quote at support.
 *
 * A uuid is unreadable and there is no order number column — inventing one is
 * a sequence, a format decision and a migration, all deferred in
 * docs/specs/order-emails.md. The first block is enough to find the row.
 */
function reference(orderId: string): string {
  return orderId.slice(0, 8);
}

function greeting(customerName: string | null): string {
  return customerName
    ? `<p>Olá, ${escapeHtml(customerName)}!</p>`
    : '<p>Olá!</p>';
}

/** "Entrega padrão, até 5 dias úteis" — the estimate only when there is one. */
function describeFreight(freight: OrderEmailFreight): string {
  const name = escapeHtml(freight.methodName);

  return freight.etaDays === null
    ? name
    : `${name}, até ${String(freight.etaDays)} dias úteis`;
}

function itemsList(items: readonly OrderEmailItem[]): string {
  const rows = items
    .map(
      (item) =>
        `<li>${String(item.quantity)} × ${escapeHtml(item.productName)} — ` +
        `${formatBRL(item.unitPriceCents * item.quantity)}</li>`,
    )
    .join('\n');

  return `<ul>\n${rows}\n</ul>`;
}

/**
 * Subtotal, freight and total — the three numbers that let a customer check
 * the arithmetic. Printing only the total would HIDE the freight inside a
 * number bigger than the items, not omit it (docs/specs/shipping.md).
 *
 * Two orders legitimately have no freight to print, and they are different:
 * one predates the shipping module (freight null — the zero in the column is a
 * backfill, and the method is genuinely unknown), the other was shipped free
 * (a real method priced at zero). The first shows the total alone, because it
 * is the only true number that order has; the second says "grátis".
 */
function moneyBlock(data: OrderEmailData): string {
  const total = `<strong>Total: ${formatBRL(data.totalCents)}</strong>`;

  if (!data.freight) {
    return `<p>${total}</p>`;
  }

  const price =
    data.freight.cents === 0 ? 'grátis' : formatBRL(data.freight.cents);

  return (
    `<p>Subtotal dos itens: ${formatBRL(data.itemsSubtotalCents)}<br />\n` +
    `Frete (${describeFreight(data.freight)}): ${price}<br />\n` +
    `${total}</p>`
  );
}

function addressBlock(address: OrderEmailAddress): string {
  const lines = [
    address.line1,
    address.line2,
    `${address.city} - ${address.state}`,
    `CEP ${address.postalCode}`,
  ].filter((line): line is string => Boolean(line));

  return (
    '<p><strong>Endereço de entrega</strong><br />\n' +
    `${lines.map((line) => escapeHtml(line)).join('<br />\n')}</p>`
  );
}

/**
 * The four shapes a shipment can take. Both halves are optional and
 * independent, and a hand-off with neither is still a real shipment — so the
 * absent case renders nothing at all rather than an empty label.
 */
function trackingBlock(data: OrderShippedEmailData): string {
  const { trackingCode, trackingUrl } = data;

  if (trackingCode && trackingUrl) {
    return (
      `<p>Código de rastreio: <a href="${escapeHtml(trackingUrl)}">` +
      `${escapeHtml(trackingCode)}</a></p>`
    );
  }

  if (trackingCode) {
    return `<p>Código de rastreio: ${escapeHtml(trackingCode)}</p>`;
  }

  if (trackingUrl) {
    return `<p><a href="${escapeHtml(trackingUrl)}">Acompanhar a entrega</a></p>`;
  }

  return '';
}

function orderLink(orderUrl: string): string {
  return `<p><a href="${escapeHtml(orderUrl)}">Ver seu pedido</a></p>`;
}

function compose(...blocks: string[]): string {
  return blocks.filter((block) => block !== '').join('\n');
}

export function orderPaidEmail(
  data: OrderEmailData,
  orderUrl: string,
): RenderedEmail {
  return {
    subject: `Pedido #${reference(data.orderId)} confirmado`,
    html: compose(
      greeting(data.customerName),
      '<p>Recebemos seu pagamento e já estamos preparando seu pedido. Obrigado pela compra!</p>',
      `<p><strong>Pedido #${reference(data.orderId)}</strong></p>`,
      itemsList(data.items),
      moneyBlock(data),
      addressBlock(data.address),
      orderLink(orderUrl),
    ),
  };
}

export function orderShippedEmail(
  data: OrderShippedEmailData,
  orderUrl: string,
): RenderedEmail {
  const method = data.freight
    ? `<p>Enviado por ${describeFreight(data.freight)}.</p>`
    : '';

  return {
    subject: `Pedido #${reference(data.orderId)} a caminho`,
    html: compose(
      greeting(data.customerName),
      `<p>Seu pedido #${reference(data.orderId)} saiu para entrega e está a caminho.</p>`,
      method,
      trackingBlock(data),
      addressBlock(data.address),
      orderLink(orderUrl),
    ),
  };
}

export function orderRefundedEmail(
  data: OrderEmailData,
  orderUrl: string,
): RenderedEmail {
  return {
    subject: `Reembolso do pedido #${reference(data.orderId)}`,
    html: compose(
      greeting(data.customerName),
      `<p>O reembolso do pedido #${reference(data.orderId)} foi processado: ` +
        `${formatBRL(data.totalCents)} voltam para a forma de pagamento usada na compra. ` +
        'O prazo de compensação depende do seu banco ou da operadora do cartão.</p>',
      orderLink(orderUrl),
    ),
  };
}

export function orderCancelledEmail(
  data: OrderEmailData,
  orderUrl: string,
): RenderedEmail {
  return {
    subject: `Pedido #${reference(data.orderId)} cancelado`,
    html: compose(
      greeting(data.customerName),
      `<p>Seu pedido #${reference(data.orderId)} foi cancelado e não será enviado. ` +
        'Nenhuma cobrança foi feita — um pedido só é cancelado enquanto ainda não foi pago.</p>',
      itemsList(data.items),
      orderLink(orderUrl),
    ),
  };
}
