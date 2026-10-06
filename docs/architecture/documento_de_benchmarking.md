# Benchmarking de Gateways de Pagamento (Brasil)

## 1. Contexto e Objetivo
Avaliar opções de gateways de pagamento para substituir ou complementar a integração atual da **Stripe** no e-commerce. O objetivo é maximizar a margem financeira do lojista (reduzindo custo por transação no PIX e taxas de antecipação de cartão) e aumentar a taxa de aprovação no checkout brasileiro, preservando uma boa experiência de desenvolvimento (DX) e do usuário (UX).

---

## 2. Peculiaridades do Mercado Brasileiro de E-commerce

1. **Predominância do PIX:**
   * Representa entre 40% e 60% das transações no varejo online.
   * Modelos percentuais (como 1,19% na Stripe) penalizam tickets médios mais altos. Modelos de custo fixo em reais (como no Asaas) geram retenção direta de lucro.
2. **Cultura do Parcelamento sem Juros:**
   * O cliente final espera parcelar em até 6x, 10x ou 12x.
   * A Stripe opera no padrão internacional (repassa uma parcela a cada 30 dias), obrigando o lojista a esperar meses ou pagar antecipação avulsa. Gateways nacionais (Mercado Pago, Pagar.me, Asaas) oferecem recebimento D+1/D+2 com regras transparentes.
3. **Antifraude e Rejeição de Cartões Nacionais:**
   * Motores globais de fraude (ex: Stripe Radar) têm alta taxa de falsos-positivos com cartões nacionais (Elo, Hipercard e cartões virtuais gerados por apps bancários).
   * Gateways consolidados no Brasil (Mercado Pago e Pagar.me/ClearSale) convertem melhor nessas bandeiras.

---

## 3. Matriz Comparativa

| Critério | Stripe | Mercado Pago | Pagar.me (Stone) | Asaas |
| :--- | :--- | :--- | :--- | :--- |
| **Foco de Mercado** | Global / SaaS / Cross-border | B2C Varejo / Marketplace | Médio e Grande Varejo / Conversão | Recorrência / PME / Cobrança Mista |
| **Taxa do PIX** | ~1,19% (percentual) | 0,99% (ou campanhas a partir de 0,49%) | ~0,99% a 1,19% | **R$ 0,99 a R$ 1,99 (Fixo)** |
| **Cartão à Vista** | ~3,99% + R$ 0,39 | ~3,98% a 4,98% (D+0 a D+30) | ~3,2% a 4,5% + R$ 0,50 | ~2,99% + R$ 0,49 |
| **Antecipação Parcelada (D+1)** | Modelo rígido internacional | Flexível com prazos customizáveis | Motor avançado de antecipação nativa | Antecipação sob demanda |
| **Antifraude** | Radar (internacional) | Motor próprio do Mercado Livre | ClearSale integrada nativa | Motor interno com alta exigência de cadastro |
| **Confiança da Marca (UX)** | Boa para devs / tech-savvy | **Altíssima no público consumidor leigo** | Invisível (transparente puro) | Baixa no B2C leigo |
| **Dev Experience (DX)** | 10/10 (Referência mundial) | 7.5/10 (Checkout Bricks maduro) | 8.5/10 (API v5 RESTful robusta) | 8/10 (API REST limpa e rápida) |

---

## 4. Simulação Financeira: Loja de Roupas (PME)

### Parâmetros da Simulação
* **Faturamento Mensal:** R$ 80.000,00
* **Ticket Médio:** R$ 250,00 (320 pedidos/mês)
* **Distribuição de Métodos:**
  * **PIX (45%):** 144 pedidos = R$ 36.000,00
  * **Cartão à Vista (20%):** 64 pedidos = R$ 16.000,00
  * **Cartão Parcelado (35%):** 112 pedidos = R$ 28.000,00 (média em 4 parcelas com antecipação D+1)

### Custos Mensais Calculados

| Estratégia | Custo PIX | Custo Cartão | Custo Total / Mês | Taxa Efetiva Total |
| :--- | :--- | :--- | :--- | :--- |
| **Stripe (100%)** | R$ 428,40 | R$ 4.207,04 | **R$ 4.635,44** | 5,79% |
| **Pagar.me (100%)** | R$ 356,40 | R$ 3.895,60 | **R$ 4.252,00** | 5,31% |
| **Mercado Pago (100%)** | R$ 356,40 | R$ 3.736,80 | **R$ 4.093,20** | 5,11% |
| **Asaas (100%)** | R$ 286,56 | R$ 3.224,64 | **R$ 3.511,20** | 4,38% |
| **Híbrido (Asaas PIX + MP Cartão)** | **R$ 286,56** | **R$ 3.736,80** | **R$ 4.023,36** | **5,02%** |
| **Híbrido (Asaas PIX + Pagar.me Cartão)** | **R$ 286,56** | **R$ 3.895,60** | **R$ 4.182,16** | **5,22%** |

### Conclusão do Benchmarking
Embora o Asaas tenha a menor taxa teórica no cartão, sua exigência rígida de dados cadastrais no checkout pode reduzir a conversão. A abordagem híbrida roteando **PIX para Asaas** e **Cartão para Mercado Pago** entrega o melhor equilíbrio entre retenção financeira imediata, familiaridade de marca para o consumidor e estabilidade de aprovação.