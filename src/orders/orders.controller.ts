import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  ApiBadRequest,
  ApiConflict,
  ApiForbidden,
  ApiNotFound,
  ApiRateLimited,
  ApiServiceUnavailable,
} from '../openapi/api-errors.decorator';
import { ApiAuthenticated } from '../openapi/security';
import { CheckoutDto } from './dto/checkout.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { PayOrderDto } from './dto/pay-order.dto';
import { ShipOrderDto } from './dto/ship-order.dto';
import { OrdersService } from './orders.service';
import { RATE_LIMITS } from './rate-limits';
import {
  OrderResponse,
  OrderWithPaymentResponse,
  PaginatedOrdersResponse,
} from './responses/order.response';

/** Repeated on every route that takes an :id — an order id is always a UUID. */
const ORDER_ID = { name: 'id', format: 'uuid' } as const;

/**
 * Lifecycle transitions are explicit verbs, not a PATCH of a status field:
 * each has its own source-state rule and its own audience, and none accepts
 * a body to tamper with. Reads and cancel pass the caller down so the
 * service can scope by ownership; back-office verbs are permission-gated
 * and unscoped. See docs/specs/orders.md.
 */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Checkout: converts the caller's cart into an order and answers with the
   * way to pay it. A PAYMENT provider outage does not fail this — the order is
   * real, `payment` comes back null, and /pay below issues the session later.
   * A SHIPPING one does (503): an order with no freight has the wrong total.
   */
  @Post()
  @ApiAuthenticated()
  @ApiOperation({
    summary: 'Check out the cart',
    description:
      "Turns the caller's cart into an immutable order, in one transaction: item names and prices are frozen, stock is decremented atomically, and the cart is consumed. Two concurrent checkouts of the same cart produce exactly one order; the loser gets a 409.\n\n`shippingOptionCode` must come from a POST /shipping/quote, and `quotedShippingCents` is **an assertion, not an instruction** — the server re-quotes and charges its own number, comparing yours only to catch a stale price. A mismatch is a 409 carrying the current options, not a silent charge at a price the customer never saw.\n\nThe two provider failures are treated differently on purpose. If the **payment** provider is down the order is still created and `payment` is null — recoverable, and POST /orders/{id}/pay is the recovery. If the **shipping** provider is down this fails with 503 and no order exists, because an order with the wrong total is born immutable and nothing can repair it.",
  })
  @ApiCreatedResponse({ type: OrderWithPaymentResponse })
  @ApiBadRequest(
    'The address failed validation, the postal code is not a well-formed CEP, or `quotedShippingCents` is negative.',
  )
  @ApiConflict(
    'The cart is empty, an item is out of stock or no longer ACTIVE (the message names the products), the shipping code is unknown, or the quoted freight no longer matches. Nothing is created and no stock moves.',
  )
  @ApiServiceUnavailable(
    'Freight could not be quoted. No order was created — retry is safe.',
  )
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutDto) {
    return this.orders.checkout(user.id, {
      address: dto.shippingAddress,
      shippingOptionCode: dto.shippingOptionCode,
      quotedShippingCents: dto.quotedShippingCents,
      paymentMode: dto.paymentMode,
    });
  }

  /**
   * (Re)issues the payment session of a CREATED order: the recovery path for a
   * checkout the provider could not complete, a closed tab, or an expired
   * session. Hands back the open session when there is one, rather than
   * creating a second way to charge the same buyer.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.ISSUE_PAYMENT })
  @HttpCode(200)
  @Post(':id/pay')
  @ApiAuthenticated()
  @ApiOperation({
    summary: '(Re)issue a payment session',
    description:
      "The recovery path: a checkout the provider could not complete, a tab the buyer closed, an expired session. Callable by the order's owner, or by anyone holding `orders.update_status`.\n\nIt **returns the existing open session** rather than creating a second one — two live ways to pay the same order is how a buyer gets charged twice. If the provider says the session is already completed, the answer is 409: the money is in flight and only the confirmation is late.",
  })
  @ApiOkResponse({ type: OrderWithPaymentResponse })
  @ApiForbidden(
    "Paying someone else's order requires the `orders.update_status` permission.",
  )
  @ApiNotFound(
    'No such order — or it belongs to someone else and the caller has no `orders.read`.',
  )
  @ApiConflict(
    'The order is not CREATED (already paid, cancelled, refunded), or the provider reports its session as already completed.',
  )
  @ApiRateLimited(RATE_LIMITS.ISSUE_PAYMENT.limit, 'minute')
  @ApiServiceUnavailable(
    'The payment provider is unreachable. The order is untouched; retry later.',
  )
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayOrderDto,
  ) {
    return this.orders.pay(user, id, dto.paymentMode);
  }

  @Get()
  @ApiAuthenticated()
  @ApiOperation({
    summary: 'List orders',
    description:
      "Scoped by who is asking. Without `orders.read` the listing is silently limited to the caller's own orders — there is no way to ask for anyone else's. With it, every order is visible and the `userId` filter becomes usable.\n\nA `userId` filter naming a user with no orders is an empty list, not a 404.",
  })
  @ApiOkResponse({ type: PaginatedOrdersResponse })
  @ApiBadRequest('A query parameter failed validation.')
  @ApiForbidden(
    'The `userId` filter was used without the `orders.read` permission.',
  )
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.orders.list(user, query);
  }

  @Get(':id')
  @ApiAuthenticated()
  @ApiOperation({
    summary: 'Get one order',
    description:
      "Someone else's order answers **404, not 403** — confirming that an id exists would leak the existence of other people's orders to anyone willing to guess. A caller holding `orders.read` sees any order.",
  })
  @ApiParam(ORDER_ID)
  @ApiOkResponse({ type: OrderResponse })
  @ApiNotFound(
    'No such order, or it belongs to someone else. The two are deliberately indistinguishable.',
  )
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.findOne(user, id);
  }

  /** Customers cancel their own CREATED orders; orders.cancel reaches any. */
  @HttpCode(200)
  @Post(':id/cancel')
  @ApiAuthenticated()
  @ApiOperation({
    summary: 'Cancel an order',
    description:
      "`CREATED → CANCELLED`, returning every item to stock. A customer may cancel their own; `orders.cancel` reaches anyone's.\n\nOnly a CREATED order can be cancelled. A PAID one is a 409 — giving money back is a different event with its own route and its own permission (POST /orders/{id}/refund). SHIPPED and DELIVERED are never cancellable.\n\nNote the two failure codes: a caller who cannot **see** the order gets 404, while one who can see it but may not cancel it gets 403.",
  })
  @ApiParam(ORDER_ID)
  @ApiOkResponse({ type: OrderResponse })
  @ApiForbidden(
    "Cancelling someone else's order requires the `orders.cancel` permission.",
  )
  @ApiNotFound('No such order, or it belongs to someone else.')
  @ApiConflict(
    'The order is not CREATED. PAID orders are refunded, not cancelled; SHIPPED and DELIVERED are final.',
  )
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.cancel(user, id);
  }

  /**
   * The CREATED → PAID seam. Today an operator records the payment by hand
   * (bank transfer, Pix); when Stripe lands, its webhook calls the same
   * OrdersService.markPaid and this route simply remains.
   */
  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @HttpCode(200)
  @Post(':id/mark-paid')
  @ApiOperation({
    summary: 'Record a payment by hand',
    description:
      "`CREATED → PAID`, for money that arrived outside the payment provider — a bank transfer, a Pix. The provider's webhook drives the same transition on its own; this route exists for everything the provider never sees.\n\nCalling it on an order that is already PAID is a 409. Webhook redelivery is deduplicated elsewhere and does not come through here.",
  })
  @ApiParam(ORDER_ID)
  @ApiOkResponse({ type: OrderResponse })
  @ApiNotFound('No such order.')
  @ApiConflict('The order is not CREATED.')
  markPaid(@Param('id') id: string) {
    return this.orders.markPaid(id);
  }

  /**
   * `PAID → REFUNDED`: money back, stock back. Separate from cancel on
   * purpose — an abandoned unpaid order and a reversed sale are different
   * events — and gated by orders.refund, which only `admin` holds.
   */
  @RequirePermissions(PERMISSIONS.ORDERS_REFUND)
  @HttpCode(200)
  @Post(':id/refund')
  @ApiOperation({
    summary: 'Refund a paid order',
    description:
      '`PAID → REFUNDED`: money back to the buyer, items back to the shelf. Full refunds only in v1.\n\nREFUNDED is a status of its own rather than CANCELLED, because a reversed sale and an abandoned unpaid order are different business events and anything counting one should not have to inspect a refund reference to exclude the other.\n\nOf the default roles only `admin` holds `orders.refund` — an operator who can ship and mark paid still cannot move money.',
  })
  @ApiParam(ORDER_ID)
  @ApiOkResponse({ type: OrderResponse })
  @ApiNotFound('No such order.')
  @ApiConflict('The order is not PAID.')
  refund(@Param('id') id: string) {
    return this.orders.refund(id);
  }

  /** Tracking details are optional — see ShipOrderDto for why. */
  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @HttpCode(200)
  @Post(':id/ship')
  @ApiOperation({
    summary: 'Mark an order shipped',
    description:
      '`PAID → SHIPPED`. Tracking details are optional, and that is a business rule rather than a gap: a local courier hand-off is a real shipment with no code to quote, and demanding one would block it.',
  })
  @ApiParam(ORDER_ID)
  @ApiOkResponse({ type: OrderResponse })
  @ApiBadRequest('`trackingUrl` is not a valid URL.')
  @ApiNotFound('No such order.')
  @ApiConflict('The order is not PAID.')
  ship(@Param('id') id: string, @Body() dto: ShipOrderDto) {
    return this.orders.ship(id, dto);
  }

  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @HttpCode(200)
  @Post(':id/deliver')
  @ApiOperation({
    summary: 'Mark an order delivered',
    description: '`SHIPPED → DELIVERED`, the terminal state of a happy order.',
  })
  @ApiParam(ORDER_ID)
  @ApiOkResponse({ type: OrderResponse })
  @ApiNotFound('No such order.')
  @ApiConflict('The order is not SHIPPED.')
  deliver(@Param('id') id: string) {
    return this.orders.deliver(id);
  }
}
