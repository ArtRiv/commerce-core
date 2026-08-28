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
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { Public } from '../auth/public.decorator';
import {
  ApiBadRequest,
  ApiConflict,
  ApiForbidden,
  ApiNotFound,
} from '../openapi/api-errors.decorator';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateVariantDto } from './dto/create-variant.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { RemoveVariantQueryDto } from './dto/remove-variant-query.dto';
import { RenameVariantDto } from './dto/rename-variant.dto';
import { ReorderVariantsDto } from './dto/reorder-variants.dto';
import { SetStockDto } from './dto/set-stock.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
import {
  PaginatedProductsResponse,
  ProductResponse,
} from './responses/product.response';
import { VariantInCartsResponse } from './responses/variant-in-carts.response';
import { StockService } from './stock.service';

/**
 * Reads are public — a storefront browses without logging in — but
 * privilege-aware: products.read unlocks DRAFT/ARCHIVED visibility, which is
 * what that permission exists for (operators hold it, plain customers do
 * not). Writes require the products.* permission for the verb; a customer's
 * token clears authentication and fails authorization, which is the RBAC 403
 * the auth spec left open.
 */
@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly stock: StockService,
  ) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  @ApiOperation({
    summary: 'List products',
    description:
      'The storefront listing. Public, but privilege-aware: **sending a bearer token that carries `products.read` changes what comes back**, since only that caller may use the `status` filter and therefore see DRAFT or ARCHIVED products. Without a token, or with one lacking the permission, the listing is ACTIVE products only.\n\nOpenAPI cannot express "optional bearer", so this route is documented as unauthenticated — but a token is accepted, and a token that is offered and rejected is a 401 rather than a silent downgrade to anonymous.',
  })
  @ApiOkResponse({ type: PaginatedProductsResponse })
  @ApiBadRequest(
    'A query parameter failed validation — a non-integer `page`, or a `status` outside the enum.',
  )
  @ApiForbidden(
    'The `status` filter was used without the `products.read` permission. Asking a privileged question is refused rather than silently answered as if ACTIVE had been requested.',
  )
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
  @ApiOperation({
    summary: 'Get one product',
    description:
      'Accepts either the id or the slug in the same path segment — ids are UUIDs and slugs never look like one, so the two cannot collide. Prefer the id for links that must survive a rename.\n\nA non-ACTIVE product is a 404 to anyone without `products.read`, identical to a product that does not exist. A 403 would confirm to someone probing slugs that an unreleased product is sitting there.',
  })
  @ApiParam({
    name: 'idOrSlug',
    description: 'The product UUID or its slug.',
    example: 'camiseta-azul',
  })
  @ApiOkResponse({ type: ProductResponse })
  @ApiNotFound(
    'No such product — or it is DRAFT/ARCHIVED and the caller lacks `products.read`. The two are deliberately indistinguishable.',
  )
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
  @ApiOperation({
    summary: 'Create a product',
    description:
      'Products are born DRAFT and stay off the storefront until moved to ACTIVE. Omitting `slug` generates one from the name, adding a numeric suffix on collision; sending one that is already taken is a 409 instead, because a caller who chose the slug wants that slug.\n\nSend `variants` in display order — `[{ "label": "P" }, { "label": "M" }, …]` — and their `position` follows the array. Omit it and the product is born with exactly one variant labelled `Único`: a product is never created without at least one, because stock lives on the variant and a product with none would be unbuyable.',
  })
  @ApiCreatedResponse({ type: ProductResponse })
  @ApiBadRequest(
    '`priceCents` is not an integer above zero, a category id is not a UUID, an image is not a URL, the slug is not lowercase-hyphenated, or two variants share a label.',
  )
  @ApiConflict('The slug sent explicitly is already taken.')
  @ApiNotFound('One of the `categoryIds` does not exist.')
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Post(':id/variants')
  @ApiOperation({
    summary: 'Add a size to a product',
    description:
      'Adds one variant. `position` defaults to one past the highest in use — the end of the list — and `stockQuantity` defaults to 0, which is a real state: the size exists and has none left.\n\nRenaming, reordering and removing are the three routes below (docs/specs/variant-management.md). Removal is the only one that can refuse: a size that was sold, or the last one a product has, stays.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({
    type: ProductResponse,
    description: 'The whole product, with its variants in display order.',
  })
  @ApiBadRequest('`label` is empty or too long, or `position` is negative.')
  @ApiConflict('This product already has a variant with that label.')
  @ApiNotFound('No product with that id.')
  addVariant(@Param('id') id: string, @Body() dto: CreateVariantDto) {
    return this.products.addVariant(id, dto);
  }

  /**
   * DECLARED BEFORE the rename route below, and that is load-bearing: the two
   * paths have the same shape, so with the order reversed `order` would be
   * captured as a `variantId` and reordering would answer an inexplicable 404.
   * There is an e2e regression test for exactly this, because an innocent
   * reshuffle of methods in this file would break it silently.
   */
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id/variants/order')
  @ApiOperation({
    summary: 'Reorder a product’s sizes',
    description:
      'Restates the whole display order: send **exactly** this product’s variants, in the order they should appear, and each `position` becomes its index in that list.\n\nA partial list is a 400 rather than a partial reorder — it does not say where the sizes it omitted should go. All positions are written in one transaction, so a failure cannot leave half an ordering behind.\n\nOrdering is explicit because alphabetical is wrong: P/M/G/GG/XGG sorts to G, GG, M, P, XGG.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ProductResponse })
  @ApiBadRequest(
    '`variantIds` is not exactly this product’s variants — one missing, one repeated, or one belonging to another product.',
  )
  @ApiNotFound('No product with that id.')
  reorderVariants(@Param('id') id: string, @Body() dto: ReorderVariantsDto) {
    return this.products.reorderVariants(id, dto.variantIds);
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id/variants/:variantId')
  @ApiOperation({
    summary: 'Rename a size',
    description:
      '**Placed orders are untouched.** `OrderItem.variantLabel` is a snapshot taken at purchase, so renaming a size cannot rewrite what somebody bought — which is exactly why this operation is safe and why the snapshot exists.\n\nCarts are the deliberate opposite: they hold no snapshot, so a cart line immediately shows the new label. That is the current truth a cart promises.\n\nRenaming a size to the label it already has does nothing and answers 200.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({ type: ProductResponse })
  @ApiBadRequest('`label` is empty or longer than 20 characters.')
  @ApiConflict('Another size of this product already has that label.')
  @ApiNotFound('No such product, or that variant does not belong to it.')
  renameVariant(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Body() dto: RenameVariantDto,
  ) {
    return this.products.renameVariant(id, variantId, dto.label);
  }

  /**
   * Gated on products.delete rather than products.update, unlike the two
   * PATCHes above: this is the only variant operation that destroys anything —
   * the size's stock, and potentially other people's cart lines. It sits with
   * archiving a product and deleting a category, which is what that permission
   * already governs.
   */
  @RequirePermissions(PERMISSIONS.PRODUCTS_DELETE)
  @Delete(':id/variants/:variantId')
  @ApiOperation({
    summary: 'Remove a size',
    description:
      'Three refusals, in the order you cannot argue with them:\n\n1. **The last variant never goes.** Every product has at least one size, always — one with none is unbuyable. No parameter overrides this; archive the product instead (`DELETE /products/{id}`).\n2. **A size somebody bought never goes.** Order items reference it forever and the database RESTRICTs the deletion; this route turns that refusal into a 409 with a sentence rather than a 500. If a size is stuck this way, **rename it** — that is the escape hatch, and it costs history nothing.\n3. **Carts do not veto, but they are not discarded silently either.** A size sitting in any cart is a 409 carrying `cartLineCount`. To go through, send both `discardCartLines=true` (authorising the destruction) and `expectedCartLineCount` (confirming the impact you just reviewed). The count is taken again under a row lock inside the transaction: if it changed in either direction, nothing is deleted and the 409 carries the new number.\n\nThe variant and the cart lines are removed by this route, in one transaction — not left to the FK cascade, which remains only as a referential safety net.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({
    type: ProductResponse,
    description: 'The product, now without that size.',
  })
  @ApiBadRequest(
    'One half of the confirmation was sent without the other, or `discardCartLines` was neither `true` nor `false`.',
  )
  @ApiResponse({
    status: 409,
    type: VariantInCartsResponse,
    description:
      'Refused: it is the last variant, it has been sold, or carts hold it and the impact was not authorised and confirmed. Only the cart cases carry `cartLineCount`.',
  })
  @ApiNotFound('No such product, or that variant does not belong to it.')
  removeVariant(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Query() query: RemoveVariantQueryDto,
  ) {
    return this.products.removeVariant(id, variantId, {
      discardCartLines: query.discardCartLines ?? false,
      expectedCartLineCount: query.expectedCartLineCount,
    });
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id/variants/:variantId/stock')
  @ApiOperation({
    summary: "Set one size's stock to an absolute quantity",
    description:
      'An inventory correction — "the shelf holds N of this size" — not a delta. Selling is the other path: checkout decrements the variant atomically inside its transaction, and nothing here is involved in that.\n\nStock belongs to the variant, never to the product: `ProductResponse.stockQuantity` is the sum across sizes, computed on read, so it cannot drift from what checkout takes.\n\nBe aware this is last-write-wins against a concurrent sale, which is accepted for v1 (docs/specs/catalog.md).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({ type: ProductResponse })
  @ApiBadRequest('`quantity` is negative or not an integer.')
  @ApiNotFound('No such product, or that variant does not belong to it.')
  async setStock(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Body() dto: SetStockDto,
  ) {
    // The variant is addressed under its product in the URL, so a variantId
    // belonging to some OTHER product must not be writable through this path —
    // otherwise the product segment would be decoration.
    await this.products.assertVariantBelongsTo(id, variantId);
    await this.stock.setQuantity(variantId, dto.quantity);

    return this.products.findOne(id, { includeNonActive: true });
  }

  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @Patch(':id')
  @ApiOperation({
    summary: 'Update a product',
    description:
      'Every field is optional; omitted fields are left alone. `categoryIds` is the exception to "partial": absent leaves the associations untouched, present **replaces the whole set**.\n\nThis is also how a product reaches ACTIVE — there is no separate publish route.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ProductResponse })
  @ApiBadRequest('A field failed validation.')
  @ApiConflict('The new slug is already taken.')
  @ApiNotFound('No product with that id, or a category id does not exist.')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  /** DELETE archives — see ProductsService.archive on why nothing is deleted. */
  @RequirePermissions(PERMISSIONS.PRODUCTS_DELETE)
  @Delete(':id')
  @ApiOperation({
    summary: 'Archive a product',
    description:
      '**Archives rather than deletes.** Orders reference products forever, so removing the row would break financial history; the product moves to ARCHIVED, leaves the storefront and refuses new sales, and the row stays.\n\nThe response is the archived product, not an empty body.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ProductResponse })
  @ApiNotFound('No product with that id.')
  archive(@Param('id') id: string) {
    return this.products.archive(id);
  }

  private canReadAll(user?: AuthenticatedUser): boolean {
    return user?.permissions.has(PERMISSIONS.PRODUCTS_READ) ?? false;
  }
}
