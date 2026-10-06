# Testes de Carga & Resiliência (k6) — Commerce-Core

Este diretório contém os scripts de teste de carga e resiliência desenvolvidos para o backend headless **commerce-core** utilizando o **k6**.

---

## 1. Scripts Disponíveis

### `concurrent-buyers.js`
Simula o comportamento de múltiplos compradores virtuais concorrentes (VUs) executando o fluxo completo:
1. `GET /products` (Navegação no catálogo)
2. `GET /products/:idOrSlug` (Visualização de detalhe de peça)
3. `GET /shipping/cep/:postalCode` (Consulta de CEP)
4. `POST /auth/login` (Autenticação de comprador)
5. `POST /cart/items` (Adição de variante à sacola)
6. `POST /shipping/quote` (Cálculo de opções de frete)
7. `POST /orders` (Checkout com método PIX ou Cartão)

**Thresholds validados:**
- Latência p(95) < 600ms, p(99) < 1200ms
- Taxa de falhas HTTP < 2%
- Sucesso de finalização de checkout > 95%

### `rate-limiting.js`
Valida a eficácia e o isolamento dos guardas de limitação de taxa (`ClientIpThrottlerGuard`):
- Dispara uma rajada controlada na rota de CEP (`GET /shipping/cep/:postalCode`), que possui limite de 30 requisições por minuto.
- Valida a ativação correta do código HTTP **429 (Too Many Requests)** com o cabeçalho `Retry-After`.
- Executa simultaneamente requisições no catálogo público (`GET /products`) para garantir que o estrangulamento da rota abusada não degrada o restante do tráfego legítimo.

---

## 2. Como Executar

### Pré-requisito: Backend em Execução
O `commerce-core` deve estar rodando localmente (porta 3000 por padrão) ou apontado para a instância de staging:
```bash
cd commerce-core
pnpm start:dev
```

### Opção A: Com k6 instalado localmente
Se você tiver o `k6` instalado no sistema (`winget install Grafana.k6` ou `brew install k6`):

```bash
# Executar teste de carga de compradores concorrentes
k6 run load-tests/concurrent-buyers.js

# Ou com variáveis de ambiente customizadas
k6 run -e API_URL=http://localhost:3000 load-tests/concurrent-buyers.js

# Executar validação de rate limiting
k6 run load-tests/rate-limiting.js
```

Ou através dos scripts configurados no `package.json`:
```bash
pnpm test:load
pnpm test:load:rate-limit
```

### Opção B: Via Docker (sem instalação local)
Caso prefira rodar via container oficial do Grafana k6:

```bash
# Compradores concorrentes (usando host.docker.internal para alcançar o localhost da máquina)
docker run --rm -i -e API_URL=http://host.docker.internal:3000 grafana/k6 run - <load-tests/concurrent-buyers.js

# Rate limiting
docker run --rm -i -e API_URL=http://host.docker.internal:3000 grafana/k6 run - <load-tests/rate-limiting.js
```
