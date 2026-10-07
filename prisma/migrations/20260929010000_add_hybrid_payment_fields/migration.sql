-- Migração: Adiciona campos de pagamento híbrido ao modelo de pedidos.
-- paymentMethod: qual gateway processou (PIX=Asaas, CREDIT_CARD=MercadoPago, STRIPE=Stripe).
-- pix_payload: código EMV Copia e Cola para pagamentos PIX.
-- pix_qr_code: imagem base64 do QR Code dinâmico para pagamentos PIX.
ALTER TABLE "orders"
  ADD COLUMN "payment_method" TEXT,
  ADD COLUMN "pix_payload" TEXT,
  ADD COLUMN "pix_qr_code" TEXT;
