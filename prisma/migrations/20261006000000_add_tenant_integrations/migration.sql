-- Migração: Cria tabelas tenant_integrations e marketplace_item_mappings e campos de canal em orders

CREATE TABLE "tenant_integrations" (
  "id"                     TEXT NOT NULL,
  "tenant_id"              TEXT NOT NULL DEFAULT 'default',
  "provider"               TEXT NOT NULL,
  "credentials_encrypted"  TEXT NOT NULL,
  "status"                 TEXT NOT NULL DEFAULT 'ACTIVE',
  "expires_at"             TIMESTAMPTZ,
  "metadata"               JSONB,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tenant_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_integrations_tenant_id_provider_key"
  ON "tenant_integrations"("tenant_id", "provider");

CREATE TABLE "marketplace_item_mappings" (
  "id"                     TEXT NOT NULL,
  "tenant_id"              TEXT NOT NULL DEFAULT 'default',
  "provider"               TEXT NOT NULL DEFAULT 'MERCADO_LIVRE',
  "external_item_id"       TEXT NOT NULL,
  "external_variation_id"  TEXT NOT NULL DEFAULT '',
  "product_id"             TEXT NOT NULL,
  "variant_id"             TEXT NOT NULL,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "marketplace_item_mappings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "marketplace_item_mappings_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,
  CONSTRAINT "marketplace_item_mappings_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "marketplace_item_mappings_provider_external_item_id_external_variation_id_key"
  ON "marketplace_item_mappings"("provider", "external_item_id", "external_variation_id");

CREATE INDEX "marketplace_item_mappings_variant_id_idx"
  ON "marketplace_item_mappings"("variant_id");

ALTER TABLE "orders"
  ADD COLUMN "origin_channel"    TEXT NOT NULL DEFAULT 'STOREFRONT',
  ADD COLUMN "external_order_id" TEXT;

CREATE INDEX "orders_external_order_id_idx"
  ON "orders"("external_order_id");
