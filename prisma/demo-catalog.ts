import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';

/**
 * A small demonstration catalogue, kept deliberately separate from
 * prisma/seed.ts.
 *
 * seed.ts is the source of truth for roles and permissions: it derives them
 * from src/auth/authz/role-permissions.ts and re-syncs on every deploy, which
 * is why the entrypoint runs it every time the container starts. This file is
 * sample DATA — someone may edit a price or archive a product through the API,
 * and a deploy that silently rewrote those edits would be a bug. So it runs by
 * hand, once: `pnpm demo:catalog`.
 *
 * Every product carries a real weightGrams. Without one a product quotes at
 * SHIPPING_DEFAULT_WEIGHT_GRAMS (500 g) and anything heavier is under-quoted
 * with the store eating the difference (docs/specs/shipping.md) — a fine
 * fallback for a legacy row, a poor look on a catalogue created today.
 *
 * Every product also carries its VARIANTS, because stock lives on the variant
 * and a product without one is unbuyable (docs/specs/product-variants.md). The
 * clothing here gets real sizes; a mug gets the single `UNICO` variant, which
 * is the same shape and not a special case.
 */

const connectionString = process.env['DATABASE_URL'];

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

/** What a product with no sizes of its own carries. Never absent. */
const SINGLE = 'Único';

/** P/M/G/GG/XGG in display order — position is the index, never the label. */
function SIZES(stock: Record<string, number>) {
  return ['P', 'M', 'G', 'GG', 'XGG'].map((label, position) => ({
    label,
    position,
    stockQuantity: stock[label] ?? 0,
  }));
}

const CATEGORIES = [
  {
    slug: 'canecas',
    name: 'Canecas',
    description: 'Canecas de cerâmica e de metal.',
  },
  {
    slug: 'camisetas',
    name: 'Camisetas',
    description: 'Camisetas de algodão, modelagem unissex.',
  },
  {
    slug: 'acessorios',
    name: 'Acessórios',
    description: 'Pequenos objetos de mesa e mochila.',
  },
] as const;

/**
 * Weights are the shipped article including its packaging, because that is
 * what the carrier bills: a 340 g mug in a box with padding is the ~520 g the
 * freight table has to price.
 */
const PRODUCTS = [
  {
    slug: 'caneca-ceramica-branca',
    name: 'Caneca de cerâmica branca 325ml',
    description:
      'Caneca de cerâmica esmaltada, 325 ml. Apta para micro-ondas e lava-louças.',
    priceCents: 4990,
    weightGrams: 520,
    variants: [{ label: SINGLE, position: 0, stockQuantity: 40 }],
    categories: ['canecas'],
  },
  {
    slug: 'caneca-termica-inox',
    name: 'Caneca térmica de inox 400ml',
    description:
      'Parede dupla a vácuo, tampa rosqueável. Mantém a bebida quente por cerca de 6 horas.',
    priceCents: 12900,
    weightGrams: 610,
    variants: [{ label: SINGLE, position: 0, stockQuantity: 25 }],
    categories: ['canecas', 'acessorios'],
  },
  {
    slug: 'camiseta-algodao-preta',
    name: 'Camiseta de algodão preta',
    description: 'Malha penteada 30.1, gola careca, modelagem unissex.',
    priceCents: 7900,
    weightGrams: 220,
    // A garment gets real sizes, and one of them is deliberately at zero:
    // "this size exists and has none left" is a state the storefront must be
    // able to render, and a demo catalogue that never shows it is a demo of
    // half the feature.
    variants: SIZES({ P: 12, M: 20, G: 18, GG: 8, XGG: 0 }),
    categories: ['camisetas'],
  },
  {
    slug: 'moletom-com-capuz',
    name: 'Moletom com capuz cinza',
    description: 'Moletom flanelado, bolso canguru, punhos em ribana.',
    priceCents: 19900,
    // The reason weights matter: at the 500 g default this would be quoted in
    // the cheapest bracket and ship in the most expensive one.
    weightGrams: 1180,
    variants: SIZES({ P: 4, M: 6, G: 5, GG: 3, XGG: 0 }),
    categories: ['camisetas'],
  },
  {
    slug: 'mousepad-tecido-grande',
    name: 'Mousepad de tecido 900x400mm',
    description: 'Base de borracha antiderrapante, bordas costuradas.',
    priceCents: 8900,
    weightGrams: 430,
    variants: [{ label: SINGLE, position: 0, stockQuantity: 35 }],
    categories: ['acessorios'],
  },
  {
    slug: 'garrafa-inox-750ml',
    name: 'Garrafa térmica de inox 750ml',
    description: 'Inox 304, parede dupla, boca larga.',
    priceCents: 15900,
    weightGrams: 940,
    variants: [{ label: SINGLE, position: 0, stockQuantity: 22 }],
    categories: ['acessorios'],
  },
] as const;

async function main() {
  const categoryIdBySlug = new Map<string, string>();

  for (const category of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      create: category,
      update: { name: category.name, description: category.description },
      select: { id: true },
    });

    categoryIdBySlug.set(category.slug, row.id);
  }

  for (const { categories, variants, ...product } of PRODUCTS) {
    const links = categories.map((slug) => {
      const categoryId = categoryIdBySlug.get(slug);

      if (!categoryId) {
        throw new Error(
          `Product "${product.slug}" references unknown category "${slug}".`,
        );
      }

      return { categoryId };
    });

    // ACTIVE rather than the DRAFT default: a product nobody can see is not a
    // demonstration of anything.
    //
    // `status` and the VARIANTS (with their stock) are set on create and never
    // on update, so re-running this does not resurrect an archived product,
    // refill stock that real orders consumed, or duplicate a size. Name, price,
    // weight and categories ARE re-synced, because those are what this file is
    // the source of.
    await prisma.product.upsert({
      where: { slug: product.slug },
      create: {
        ...product,
        status: 'ACTIVE',
        imageUrls: [],
        categories: { create: links },
        variants: { create: [...variants] },
      },
      update: {
        name: product.name,
        description: product.description,
        priceCents: product.priceCents,
        weightGrams: product.weightGrams,
        categories: { deleteMany: {}, create: links },
      },
    });
  }

  const [categories, products, variants] = await Promise.all([
    prisma.category.count(),
    prisma.product.count(),
    prisma.productVariant.count(),
  ]);

  console.log(
    'Demo catalogue ready:',
    products,
    'products,',
    variants,
    'variants,',
    categories,
    'categories.',
  );
}

main()
  .catch((err: unknown) => {
    console.error('Demo catalogue seed failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
