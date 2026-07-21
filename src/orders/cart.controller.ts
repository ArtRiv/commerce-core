import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { CartService } from './cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { SetCartItemQuantityDto } from './dto/set-cart-item-quantity.dto';

/**
 * Every route acts on the caller's own cart — there is no cart id in any URL,
 * so "whose cart" is answered by the token alone and cross-user access is
 * unrepresentable. All routes require authentication (v1 has no guest carts,
 * docs/specs/orders.md); no permissions involved, a cart is not privileged.
 */
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.getCart(user.id);
  }

  @Post('items')
  addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(user.id, dto.productId, dto.quantity);
  }

  @Patch('items/:productId')
  setQuantity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: SetCartItemQuantityDto,
  ) {
    return this.cart.setQuantity(user.id, productId, dto.quantity);
  }

  @Delete('items/:productId')
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
  ) {
    return this.cart.removeItem(user.id, productId);
  }

  @Delete()
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.clear(user.id);
  }
}
