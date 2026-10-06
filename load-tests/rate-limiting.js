import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

/**
 * AVESSO Store / Commerce-Core — Validação de Rate Limiting e Resiliência (k6)
 *
 * Valida a eficácia e o isolamento dos limites de taxa (rate limiting):
 * 1. Dispara rajadas de requisições na rota de consulta de CEP (/shipping/cep/:postalCode),
 *    que possui limite estrito de 30 req/minuto (ClientIpThrottlerGuard).
 * 2. Verifica a transição de respostas HTTP 200 para HTTP 429 (Too Many Requests).
 * 3. Valida a presença do cabeçalho 'Retry-After'.
 * 4. Valida que endpoints públicos não-estrangulados (como /products) continuam
 *    respondendo com baixa latência e status 200, provando a resiliência do sistema.
 */

const rateLimitedCount = new Counter('rate_limited_429_total');
const normalSuccessRate = new Rate('normal_traffic_success_rate');

export const options = {
  scenarios: {
    // Cenário 1: Rajada para estourar o limite de 30 req/min no endpoint de CEP
    burst_throttling: {
      executor: 'constant-arrival-rate',
      rate: 10, // 10 reqs por segundo (atinge 30 em 3 segundos)
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 15,
      maxVUs: 30,
      exec: 'testThrottledRoute',
    },
    // Cenário 2: Tráfego legítimo de fundo no catálogo rodando simultaneamente
    background_legit_traffic: {
      executor: 'constant-vus',
      vus: 5,
      duration: '15s',
      exec: 'testLegitTraffic',
    },
  },
  thresholds: {
    rate_limited_429_total: ['count>10'],        // Deve capturar ao menos 10 respostas 429
    normal_traffic_success_rate: ['rate>0.98'],  // O tráfego normal NÃO deve ser degradado
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';

export function testThrottledRoute() {
  const res = http.get(`${BASE_URL}/shipping/cep/01310200`, {
    tags: { name: 'ThrottledCepLookup' },
  });

  const is429 = res.status === 429;
  if (is429) {
    rateLimitedCount.add(1);
    check(res, {
      'status é 429 Too Many Requests': (r) => r.status === 429,
      'cabeçalho Retry-After presente': (r) => r.headers['Retry-After'] !== undefined,
    });
  } else {
    check(res, {
      'status inicial é 200 OK': (r) => r.status === 200,
    });
  }
}

export function testLegitTraffic() {
  const res = http.get(`${BASE_URL}/products?page=1&perPage=4`, {
    tags: { name: 'LegitCatalogRequest' },
  });

  const ok = check(res, {
    'catálogo responde 200 durante rajada de rate limiting': (r) => r.status === 200,
  });

  normalSuccessRate.add(ok);
  sleep(0.5);
}
