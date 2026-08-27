import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiBadRequest, ApiNotFound } from '../openapi/api-errors.decorator';
import { ApiAuthenticated } from '../openapi/security';
import { CartService } from './cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { SetCartItemQuantityDto } from './dto/set-cart-item-quantity.dto';
import { CartResponse } from './responses/cart.response';

/**
 * Every route acts on the caller's own cart — there is no cart id in any URL,
 * so "whose cart" is answered by the token alone and cross-user access is
 * unrepresentable. All routes require authentication (v1 has no guest carts,
 * docs/specs/orders.md); no permissions involved, a cart is not privileged.
 */
@ApiTags('cart')
@ApiAuthenticated()
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the current cart',
    description:
      'Always succeeds for an authenticated caller. A user who has never added anything gets an empty cart with both totals at `0` rather than a 404 — the cart is created lazily on the first add, and its absence is not an error.\n\nCatalogue data on each line is read **live**, not frozen: price, status and the size’s own stock are current as of this request. That is what lets a storefront warn "only 2 left" or "no longer available". Prices freeze at checkout and not before.\n\nEach line names a **variant** — `variantId` is what PATCH and DELETE address, and the stock that matters is `variant.stockQuantity`, the count for that size, not a product-wide total.\n\n`itemsSubtotalCents` and `itemCount` are computed here from those same live prices, so no client has to sum money. There is deliberately **no order total** on this route: without a postal code there is no freight, and a "total" that is missing the freight is precisely the number a checkout must never show. That one comes from POST /shipping/quote, as `orderTotalCents` per option.',
  })
  @ApiOkResponse({ type: CartResponse })
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.getCart(user.id);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Add to the cart',
    description:
      'Takes a **variantId** — a size — not a product id. A product id does not say which size, and this API refuses to pick one on your behalf (docs/specs/product-variants.md).\n\nAdditive: adding a variant already in the cart **increases** its quantity rather than creating a second line, while a different size of the same product is its own line. Use PATCH below to set an absolute quantity.\n\nOnly variants of ACTIVE products can be added. A variant of a DRAFT or ARCHIVED product and a variant that does not exist are the same 404 — the public does not get to tell an unreleased product from one that never existed.',
  })
  @ApiCreatedResponse({
    type: CartResponse,
    description: 'The whole cart, not just the line that changed.',
  })
  @ApiBadRequest('`variantId` is not a UUID, or `quantity` is outside 1–999.')
  @ApiNotFound('No such variant, or its product is not ACTIVE.')
  addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(user.id, dto.variantId, dto.quantity);
  }

  @Patch('items/:variantId')
  @ApiOperation({
    summary: 'Set a line to an absolute quantity',
    description:
      'Absolute — "make it 5" — as opposed to POST /cart/items, which adds. The line is addressed by its **variantId**. To remove a line use DELETE; zero is not a valid quantity here.',
  })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({ type: CartResponse })
  @ApiBadRequest('`quantity` is outside 1–999.')
  @ApiNotFound('That variant is not in the cart.')
  setQuantity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId') variantId: string,
    @Body() dto: SetCartItemQuantityDto,
  ) {
    return this.cart.setQuantity(user.id, variantId, dto.quantity);
  }

  @Delete('items/:variantId')
  @ApiOperation({ summary: 'Remove one line from the cart' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({ type: CartResponse })
  @ApiNotFound('That variant is not in the cart.')
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId') variantId: string,
  ) {
    return this.cart.removeItem(user.id, variantId);
  }

  @Delete()
  @ApiOperation({
    summary: 'Empty the cart',
    description:
      'Removes every line. Idempotent — emptying an already-empty cart is a 200 with an empty list, not an error.',
  })
  @ApiOkResponse({ type: CartResponse })
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.clear(user.id);
  }
}
