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
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { Public } from '../auth/public.decorator';
import {
  ApiBadRequest,
  ApiConflict,
  ApiNotFound,
} from '../openapi/api-errors.decorator';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponse } from './responses/category.response';

/**
 * Categories have no status, so the public reads need no privilege logic —
 * everyone sees the same list. Writes reuse the products.* permissions:
 * the catalog is one capability, and no role manages categories without
 * also managing products (splitting them is a deferred decision in the spec).
 */
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'List every category',
    description:
      'Unpaginated, and deliberately so: categories have no status and v1 keeps them flat with no nesting, so the whole set is small enough to be one response a storefront can cache as its navigation.',
  })
  @ApiOkResponse({ type: [CategoryResponse] })
  list() {
    return this.categories.findAll();
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get one category by slug',
    description:
      'By slug, not id — this is the storefront lookup, and the id form has no consumer. The write routes below take the id.',
  })
  @ApiParam({ name: 'slug', example: 'camisetas' })
  @ApiOkResponse({ type: CategoryResponse })
  @ApiNotFound('No category with that slug.')
  get(@Param('slug') slug: string) {
    return this.categories.findBySlug(slug);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_CREATE)
  @Post()
  @ApiOperation({
    summary: 'Create a category',
    description:
      'Gated on `products.create` rather than a category-specific permission: the catalog is treated as one capability, since no role manages one without the other. Slug behaviour matches products — generated from the name when omitted, 409 when sent and already taken.',
  })
  @ApiCreatedResponse({ type: CategoryResponse })
  @ApiBadRequest('`name` is empty, or the slug is not lowercase-hyphenated.')
  @ApiConflict('The slug sent explicitly is already taken.')
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id')
  @ApiOperation({ summary: 'Update a category' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CategoryResponse })
  @ApiBadRequest('A field failed validation.')
  @ApiConflict('The new slug is already taken.')
  @ApiNotFound('No category with that id.')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  /** Hard delete — unlike products, nothing will ever reference a category. */
  @RequirePermissions(PERMISSIONS.PRODUCTS_DELETE)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a category',
    description:
      'A real delete, unlike products — no order ever references a category, so there is no history to protect.\n\n**Products attached to it survive**, simply losing the association; a product in no category is valid. Only the association rows cascade.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({
    description: 'Deleted. Its products remain, now uncategorised.',
  })
  @ApiNotFound('No category with that id.')
  async remove(@Param('id') id: string): Promise<void> {
    await this.categories.remove(id);
  }
}
