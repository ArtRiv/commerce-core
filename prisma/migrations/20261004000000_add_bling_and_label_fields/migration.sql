-- Migração: Adiciona campos de integração com Bling ERP e etiqueta de postagem.
--
-- blingOrderId: referência do pedido no Bling, gravada após exportação automática
--               disparada no evento de pagamento confirmado (PAID). Null quando o
--               Bling está indisponível ou não configurado.
-- blingExportedAt: timestamp da última exportação bem-sucedida ao Bling.
-- labelUrl: URL temporária do PDF de etiqueta de postagem gerado via Melhor Envio.
--           Tipicamente expira em ~30 min após geração pela transportadora.
-- labelPurchasedAt: timestamp da compra da etiqueta na transportadora.
ALTER TABLE "orders"
  ADD COLUMN "bling_order_id"     TEXT,
  ADD COLUMN "bling_exported_at"  TIMESTAMPTZ,
  ADD COLUMN "label_url"          TEXT,
  ADD COLUMN "label_purchased_at" TIMESTAMPTZ;
