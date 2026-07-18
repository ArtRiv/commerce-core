import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { nextAvailableSlug, slugify } from './slug';

export interface CategoryInput {
  name: string;
  slug?: string;
  description?: string;
}

/**
 * Flat categories, hard-deleted on removal — unlike products, nothing else
 * will ever reference a category by id (orders reference products), so there
 * is no history to preserve. Deleting one detaches its products via the join
 * table's cascade; the products survive.
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CategoryInput) {
    const slug = await this.resolveSlug(input);

    return this.prisma.category.create({
      data: { name: input.name, slug, description: input.description },
    });
  }

  findAll() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }

  async findBySlug(slug: string) {
    const category = await this.prisma.category.findUnique({
      where: { slug },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  async update(id: string, input: Partial<CategoryInput>) {
    const existing = await this.prisma.category.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('Category not found');
    }

    if (input.slug && input.slug !== existing.slug) {
      await this.assertSlugFree(input.slug, id);
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description,
      },
    });
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.category.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('Category not found');
    }

    await this.prisma.category.delete({ where: { id } });
  }

  /**
   * An explicit slug is honored or refused (409) — never silently changed.
   * An auto-generated one is suffixed past collisions instead: the caller
   * expressed no preference, so any free slug derived from the name is right.
   */
  private async resolveSlug(input: CategoryInput): Promise<string> {
    if (input.slug) {
      await this.assertSlugFree(input.slug);
      return input.slug;
    }

    const base = slugify(input.name, 'categoria');
    const taken = await this.prisma.category.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });

    return nextAvailableSlug(
      base,
      taken.map((row) => row.slug),
    );
  }

  private async assertSlugFree(slug: string, ownId?: string): Promise<void> {
    const holder = await this.prisma.category.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (holder && holder.id !== ownId) {
      throw new ConflictException(`Slug "${slug}" is already in use`);
    }
  }
}
