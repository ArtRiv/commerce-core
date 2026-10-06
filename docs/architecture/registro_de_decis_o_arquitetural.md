# ADR 001: Adoção de Estratégia Híbrida de Gateways (Asaas + Mercado Pago)

* **Status:** Aceito
* **Data:** Setembro/2026
* **Decisores:** Time de Engenharia e Produto

---

## 1. Contexto
Atualmente, a plataforma conta com suporte de pagamentos inicial via Stripe. No entanto, no cenário de e-commerce brasileiro:
1. As taxas percentuais de PIX da Stripe oneram desnecessariamente o faturamento.
2. A política de repasse e liquidação de parcelas em cartão de crédito da Stripe não atende com eficiência a demanda de antecipação D+1 comum aos lojistas nacionais.
3. A Stripe apresenta índice de falso-positivo mais elevado em cartões de bandeiras nacionais e cartões virtuais.

O backend foi estruturado desde o início em torno do padrão de abstração `PaymentProvider`, permitindo plugar novos gateways sem modificar a lógica central de pedidos, carrinho e estoque.

---

## 2. Decisão
Adotar uma **arquitetura de pagamentos híbrida**:
1. **Asaas como Provedor de PIX:**
   * Utilizar a API do Asaas exclusivamente para geração e conciliação de cobranças PIX (Dynamic QR Code e Copia e Cola).
   * **Motivo:** Cobrança por valor fixo em reais (R$ 1,50 a R$ 1,99 por PIX liquidado), gerando economia direta em relação às taxas percentuais (0,99% a 1,19%) de outros provedores.
2. **Mercado Pago como Provedor de Cartão de Crédito:**
   * Utilizar o Mercado Pago (via SDK/Checkout Bricks ou Transparente) para processamento de pagamentos em cartão de crédito (à vista e parcelado).
   * **Motivo:** Reconhecimento e confiança de marca do ecossistema Mercado Livre no público brasileiro, fluxo de antecipação flexível e antifraude com histórico robusto de compradores nacionais.
3. **Evolução Futura (Pagar.me):**
   * Manter a interface desacoplada para permitir plugar o adaptador do **Pagar.me** caso a operação escale para volumes em que regras customizadas de ClearSale ou split de pagamentos justifiquem a migração.

---

## 3. Consequências

### Pontos Positivos
* **Economia Financeira Imediata:** Redução do custo por transação no PIX para taxa fixa, maximizando a margem líquida da loja.
* **Conversão e Confiança no Checkout:** Usuários finais têm alta taxa de aceitação e familiaridade com a marca Mercado Pago no momento de inserir dados de cartão.
* **Segurança de Fluxo:** Desacoplamento de dependência de um único player financeiro. Se o serviço de PIX ou Cartão de um dos parceiros sofrer instabilidade temporária, o outro método permanece operacional.

### Pontos de Atenção / Trade-offs
* **Manutenção de Múltiplos Webhooks:** O backend precisará gerenciar endpoints de webhook e assinaturas de segurança para Asaas e Mercado Pago.
* **Conciliação Financeira:** O lojista terá saldos e painéis de liquidação em duas contas distintas (conta digital Asaas e conta vendedor Mercado Pago).
* **Tratamento de Exceções:** Manter tratamento unificado de status (`PENDING`, `PAID`, `FAILED`, `REFUNDED`) independentemente do gateway de origem.

---

## 4. Diretrizes Técnicas de Implementação

1. **Contrato de Interface (`PaymentProvider`):**
   * O core do sistema interage apenas com a abstração:
   ```typescript
   export interface PaymentProvider {
     createPixPayment(data: PixPaymentDTO): Promise<PixPaymentResponse>;
     createCreditCardPayment(data: CardPaymentDTO): Promise<CardPaymentResponse>;
     handleWebhook(payload: unknown, headers: Record<string, string>): Promise<WebhookEventResult>;
     refundPayment(paymentId: string, amount?: number): Promise<RefundResponse>;
   }
   ```
2. **Roteamento de Pagamento (`PaymentFactory` / `PaymentRouter`):**
   * O serviço de checkout direciona a chamada com base no método escolhido:
     * `paymentMethod === 'PIX'` $\rightarrow$ `AsaasPaymentProvider`
     * `paymentMethod === 'CREDIT_CARD'` $\rightarrow$ `MercadoPagoPaymentProvider`
3. **Webhooks Unificados:**
   * Criar rotas dedicadas por provedor (ex: `/api/v1/webhooks/asaas` e `/api/v1/webhooks/mercadopago`) com verificação criptográfica de assinatura de cada plataforma antes de disparar o processamento assíncrono do pedido.