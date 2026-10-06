import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * AVESSO Store / Commerce-Core — Teste de Carga de Compradores Concorrentes (k6)
 *
 * Simula múltiplos compradores virtuais concorrentes (VUs) executando o fluxo
 * realista de e-commerce:
 * 1. Navegação no catálogo público (GET /products)
 * 2. Visualização dos detalhes do produto (GET /products/:idOrSlug)
 * 3. Consulta de endereço por CEP (GET /shipping/cep/:postalCode)
 * 4. Cotação de frete (POST /shipping/quote)
 * 5. Criação/adição de itens à sacola (POST /cart/items)
 * 6. Checkout do pedido com método PIX ou Cartão (POST /orders)
 */

// Métricas customizadas para observabilidade detalhada
const checkoutSuccessRate = new Rate('checkout_success_rate');
const cepLookupDuration = new Trend('cep_lookup_duration_ms');
const catalogDuration = new Trend('catalog_duration_ms');
const orderCreationCounter = new Counter('orders_created_total');

export const options = {
  stages: [
    { duration: '10s', target: 10 }, // Aquecimento (ramp-up para 10 VUs)
    { duration: '20s', target: 25 }, // Carga moderada (ramp-up para 25 VUs)
    { duration: '30s', target: 50 }, // Pico de tráfego concorrente (50 VUs)
    { duration: '15s', target: 0 },  // Desaceleração (ramp-down)
  ],
  thresholds: {
    http_req_duration: ['p(95)<600', 'p(99)<1200'], // 95% das requisições abaixo de 600ms
    http_req_failed: ['rate<0.02'],                  // Menos de 2% de falhas HTTP
    checkout_success_rate: ['rate>0.95'],            // Ao menos 95% dos checkouts bem-sucedidos
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const DEFAULT_CEP = '01310200'; // Bela Vista, SP

export default function () {
  let authToken = null;
  let selectedProduct = null;
  let selectedVariant = null;

  // 1. Navegação no Catálogo
  group('01_Catalogo', () => {
    const res = http.get(`${BASE_URL}/products?status=ACTIVE&page=1&perPage=12`, {
      tags: { name: 'GetProducts' },
    });

    catalogDuration.add(res.timings.duration);
    const ok = check(res, {
      'catálogo responde 200': (r) => r.status === 200,
      'catálogo possui itens': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.items && body.items.length > 0;
        } catch {
          return false;
        }
      },
    });

    if (ok) {
      const body = JSON.parse(res.body);
      selectedProduct = body.items[0];
      if (selectedProduct.variants && selectedProduct.variants.length > 0) {
        selectedVariant = selectedProduct.variants.find((v) => v.stockQuantity > 0) || selectedProduct.variants[0];
      }
    }
  });

  sleep(1);

  // 2. Detalhes do Produto Selecionado
  if (selectedProduct) {
    group('02_Produto_Detalhe', () => {
      const res = http.get(`${BASE_URL}/products/${selectedProduct.slug || selectedProduct.id}`, {
        tags: { name: 'GetProductDetail' },
      });

      check(res, {
        'detalhes do produto respondem 200': (r) => r.status === 200,
      });
    });

    sleep(1);
  }

  // 3. Consulta de CEP
  group('03_Consulta_CEP', () => {
    const res = http.get(`${BASE_URL}/shipping/cep/${DEFAULT_CEP}`, {
      tags: { name: 'LookupCep' },
    });

    cepLookupDuration.add(res.timings.duration);
    check(res, {
      'consulta CEP responde 200 ou 429': (r) => r.status === 200 || r.status === 429,
    });
  });

  sleep(1);

  // 4. Autenticação rápida ou sessão de teste (se credenciais forem informadas)
  const customerEmail = __ENV.CUSTOMER_EMAIL || 'cliente@avesso.test';
  const customerPass = __ENV.CUSTOMER_PASSWORD || 'correct horse battery staple';

  group('04_Autenticacao_Cliente', () => {
    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email: customerEmail, password: customerPass }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'CustomerLogin' },
      }
    );

    if (loginRes.status === 200 || loginRes.status === 201) {
      try {
        const data = JSON.parse(loginRes.body);
        authToken = data.accessToken;
      } catch {
        authToken = null;
      }
    }
  });

  // Se logado com sucesso, executa fluxo de sacola e checkout
  if (authToken && selectedVariant) {
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    };

    // 5. Adicionar à Sacola
    group('05_Sacola', () => {
      const addRes = http.post(
        `${BASE_URL}/cart/items`,
        JSON.stringify({ variantId: selectedVariant.id, quantity: 1 }),
        {
          headers: authHeaders,
          tags: { name: 'AddToCart' },
        }
      );

      check(addRes, {
        'adição à sacola responde 200 ou 201': (r) => r.status === 200 || r.status === 201,
      });
    });

    sleep(1);

    // 6. Cotação de Frete
    let shippingOptionCode = 'padrao-sudeste';
    let quotedShippingCents = 1990;

    group('06_Cotacao_Frete', () => {
      const quoteRes = http.post(
        `${BASE_URL}/shipping/quote`,
        JSON.stringify({ postalCode: DEFAULT_CEP }),
        {
          headers: authHeaders,
          tags: { name: 'QuoteShipping' },
        }
      );

      const ok = check(quoteRes, {
        'cotação frete responde 200': (r) => r.status === 200,
      });

      if (ok) {
        try {
          const body = JSON.parse(quoteRes.body);
          if (body.options && body.options.length > 0) {
            shippingOptionCode = body.options[0].code;
            quotedShippingCents = body.options[0].priceCents;
          }
        } catch {}
      }
    });

    sleep(1);

    // 7. Finalização do Pedido (Checkout com PIX)
    group('07_Checkout_PIX', () => {
      const orderPayload = {
        shippingAddress: {
          street: 'Rua Aurora',
          number: '148',
          complement: 'Apto 42',
          neighborhood: 'Bela Vista',
          city: 'São Paulo',
          state: 'SP',
          postalCode: '01310-200',
          line1: 'Rua Aurora, 148 - Bela Vista',
        },
        shippingOptionCode: shippingOptionCode,
        quotedShippingCents: quotedShippingCents,
        paymentMethod: 'PIX',
      };

      const orderRes = http.post(`${BASE_URL}/orders`, JSON.stringify(orderPayload), {
        headers: authHeaders,
        tags: { name: 'PlaceOrderPix' },
      });

      const success = check(orderRes, {
        'pedido criado com sucesso (201)': (r) => r.status === 201,
        'pedido contém dados de pagamento PIX': (r) => {
          if (r.status !== 201) return false;
          try {
            const ord = JSON.parse(r.body);
            return ord.paymentMethod === 'PIX' && (ord.pixPayload !== undefined || ord.status === 'CREATED');
          } catch {
            return false;
          }
        },
      });

      checkoutSuccessRate.add(success);
      if (success) {
        orderCreationCounter.add(1);
      }
    });
  }

  sleep(2);
}
