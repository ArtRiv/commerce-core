import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { ClientIpThrottlerGuard } from '../common/throttling/client-ip-throttler.guard';
import {
  ApiBadRequest,
  ApiConflict,
  ApiRateLimited,
  ApiServiceUnavailable,
} from '../openapi/api-errors.decorator';
import { ApiAuthenticated } from '../openapi/security';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';
import { RATE_LIMITS } from './rate-limits';
import { ShippingQuoteResponse } from './responses/shipping-quote.response';
import { ShippingQuoteService } from './shipping-quote.service';

const QUOTE_DESCRIPTION = [
  "Prices freight for the caller's own cart to a destination postal code. There is no cart id and no item list in the request — the cart is whichever one the token belongs to.",
  'The postal code alone determines the price: in Brazil the CEP fixes city and state, and it is what carriers quote against. City and state still travel in the order address, to print a label, but they never feed the price.',
  'An **empty `options` list is a legitimate 200**, not an error: "nothing can carry this, to there" is a fact about the address and the cart, and retrying will not change it. A provider that is merely unreachable answers 503 instead — the two are kept apart on purpose, because one is worth retrying and the other never is.',
  'Take the `code` of the option the customer picks and send it to POST /orders as `shippingOptionCode`, along with the `priceCents` you displayed as `quotedShippingCents`.',
  'POST rather than GET despite being a read: a postal code is personal data, and query strings end up in access logs and browser history.',
].join('\n\n');

/**
 * Serves /shipping/quote while living in `orders`, exactly like the payment
 * webhook serves /payments/webhook from here: the URL names the domain a
 * frontend is thinking about, and the code sits where the data it reads lives
 * — the caller's cart. See docs/architecture/modules.md.
 *
 * POST rather than GET despite being a read: the postal code is a piece of
 * personal data, and query strings end up in access logs and browser history.
 */
@ApiTags('shipping')
@Controller('shipping')
export class ShippingQuoteController {
  constructor(private readonly quotes: ShippingQuoteService) {}

  /**
   * Rate-limited even though today's provider is local arithmetic: behind the
   * same token there will be a carrier, and then every call is a network trip
   * and a third party's quota. Same reasoning as /orders/:id/pay.
   */
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.SHIPPING_QUOTE })
  @HttpCode(200)
  @Post('quote')
  @ApiAuthenticated()
  @ApiOperation({
    summary: 'Quote freight for the cart',
    description: QUOTE_DESCRIPTION,
  })
  @ApiOkResponse({ type: ShippingQuoteResponse })
  @ApiBadRequest(
    'The postal code is not a well-formed CEP (8 digits, hyphen optional).',
  )
  @ApiConflict('The cart is empty — there is nothing to quote.')
  @ApiRateLimited(RATE_LIMITS.SHIPPING_QUOTE.limit, 'minute')
  @ApiServiceUnavailable(
    'The shipping provider is unreachable. Distinct from an empty option list, which is a 200.',
  )
  async quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ShippingQuoteDto,
  ): Promise<ShippingQuoteResponse> {
    // An empty list is a legitimate 200: "we do not deliver there" is an
    // answer about the address, not a failure of the request.
    return { options: await this.quotes.quoteForCart(user.id, dto.postalCode) };
  }
}
