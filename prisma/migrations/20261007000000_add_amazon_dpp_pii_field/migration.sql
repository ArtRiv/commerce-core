-- Migração: Adiciona campo encrypted_buyer_pii em orders para conformidade com a Amazon SP-API DPP
ALTER TABLE "orders"
  ADD COLUMN "encrypted_buyer_pii" TEXT;
