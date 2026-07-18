import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { Public } from '../auth/public.decorator';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * Categories have no status, so the public reads need no privilege logic —
 * everyone sees the same list. Writes reuse the products.* permissions:
 * the catalog is one capability, and no role manages categories without
 * also managing products (splitting them is a deferred decision in the spec).
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  list() {
    return this.categories.findAll();
  }

  @Public()
  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.categories.findBySlug(slug);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_CREATE)
  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  /** Hard delete — unlike products, nothing will ever reference a category. */
  @RequirePermissions(PERMISSIONS.PRODUCTS_DELETE)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.categories.remove(id);
  }
}
