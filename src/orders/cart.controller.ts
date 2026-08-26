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
      'Always succeeds for an authenticated caller. A user who has never added anything gets an empty cart with both totals at `0` rather than a 404 — the cart is created lazily on the first add, and its absence is not an error.\n\nProduct data on each line is read **live from the catalog**, not frozen: price, status and stock are current as of this request. That is what lets a storefront warn "only 2 left" or "no longer available". Prices freeze at checkout and not before.\n\n`itemsSubtotalCents` and `itemCount` are computed here from those same live prices, so no client has to sum money. There is deliberately **no order total** on this route: without a postal code there is no freight, and a "total" that is missing the freight is precisely the number a checkout must never show. That one comes from POST /shipping/quote, as `orderTotalCents` per option.',
  })
  @ApiOkResponse({ type: CartResponse })
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.getCart(user.id);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Add to the cart',
    description:
      'Additive: adding a product already in the cart **increases** its quantity rather than creating a second line. Use PATCH below to set an absolute quantity.\n\nOnly ACTIVE products can be added. A DRAFT, ARCHIVED or nonexistent product is the same 404 — the public does not get to tell an unreleased product from one that never existed.',
  })
  @ApiCreatedResponse({
    type: CartResponse,
    description: 'The whole cart, not just the line that changed.',
  })
  @ApiBadRequest('`productId` is not a UUID, or `quantity` is outside 1–999.')
  @ApiNotFound('No such product, or it is not ACTIVE.')
  addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(user.id, dto.productId, dto.quantity);
  }

  @Patch('items/:productId')
  @ApiOperation({
    summary: 'Set a line to an absolute quantity',
    description:
      'Absolute — "make it 5" — as opposed to POST /cart/items, which adds. To remove a line use DELETE; zero is not a valid quantity here.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ type: CartResponse })
  @ApiBadRequest('`quantity` is outside 1–999.')
  @ApiNotFound('That product is not in the cart.')
  setQuantity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: SetCartItemQuantityDto,
  ) {
    return this.cart.setQuantity(user.id, productId, dto.quantity);
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove one line from the cart' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ type: CartResponse })
  @ApiNotFound('That product is not in the cart.')
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
  ) {
    return this.cart.removeItem(user.id, productId);
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
