import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';
import { RATE_LIMITS } from './rate-limits';
import { ShippingQuoteService } from './shipping-quote.service';

/**
 * Serves /shipping/quote while living in `orders`, exactly like the payment
 * webhook serves /payments/webhook from here: the URL names the domain a
 * frontend is thinking about, and the code sits where the data it reads lives
 * — the caller's cart. See docs/architecture/modules.md.
 *
 * POST rather than GET despite being a read: the postal code is a piece of
 * personal data, and query strings end up in access logs and browser history.
 */
@Controller('shipping')
export class ShippingQuoteController {
  constructor(private readonly quotes: ShippingQuoteService) {}

  /**
   * Rate-limited even though today's provider is local arithmetic: behind the
   * same token there will be a carrier, and then every call is a network trip
   * and a third party's quota. Same reasoning as /orders/:id/pay.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.SHIPPING_QUOTE })
  @HttpCode(200)
  @Post('quote')
  async quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ShippingQuoteDto,
  ) {
    // An empty list is a legitimate 200: "we do not deliver there" is an
    // answer about the address, not a failure of the request.
    return { options: await this.quotes.quoteForCart(user.id, dto.postalCode) };
  }
}
