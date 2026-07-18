import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { Public } from '../auth/public.decorator';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { SetStockDto } from './dto/set-stock.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
import { StockService } from './stock.service';

/**
 * Reads are public — a storefront browses without logging in — but
 * privilege-aware: products.read unlocks DRAFT/ARCHIVED visibility, which is
 * what that permission exists for (operators hold it, plain customers do
 * not). Writes require the products.* permission for the verb; a customer's
 * token clears authentication and fails authorization, which is the RBAC 403
 * the auth spec left open.
 */
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly stock: StockService,
  ) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  list(
    @Query() query: ListProductsQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    if (query.status && !this.canReadAll(user)) {
      // 403 (not silent clamping to ACTIVE): the caller asked a privileged
      // question and should learn the request was denied, not receive an
      // answer that quietly means something else.
      throw new ForbiddenException(
        'Filtering by status requires the products.read permission',
      );
    }

    return this.products.findMany(query);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':idOrSlug')
  get(
    @Param('idOrSlug') idOrSlug: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.products.findOne(idOrSlug, {
      includeNonActive: this.canReadAll(user),
    });
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_CREATE)
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id/stock')
  setStock(@Param('id') id: string, @Body() dto: SetStockDto) {
    return this.stock.setQuantity(id, dto.quantity);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  /** DELETE archives — see ProductsService.archive on why nothing is deleted. */
  @RequirePermissions(PERMISSIONS.PRODUCTS_DELETE)
  @Delete(':id')
  archive(@Param('id') id: string) {
    return this.products.archive(id);
  }

  private canReadAll(user?: AuthenticatedUser): boolean {
    return user?.permissions.has(PERMISSIONS.PRODUCTS_READ) ?? false;
  }
}
