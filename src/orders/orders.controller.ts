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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { CheckoutDto } from './dto/checkout.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { PayOrderDto } from './dto/pay-order.dto';
import { ShipOrderDto } from './dto/ship-order.dto';
import { OrdersService } from './orders.service';
import { RATE_LIMITS } from './rate-limits';

/**
 * Lifecycle transitions are explicit verbs, not a PATCH of a status field:
 * each has its own source-state rule and its own audience, and none accepts
 * a body to tamper with. Reads and cancel pass the caller down so the
 * service can scope by ownership; back-office verbs are permission-gated
 * and unscoped. See docs/specs/orders.md.
 */
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
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayOrderDto,
  ) {
    return this.orders.pay(user, id, dto.paymentMode);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.orders.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.findOne(user, id);
  }

  /** Customers cancel their own CREATED orders; orders.cancel reaches any. */
  @HttpCode(200)
  @Post(':id/cancel')
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
  refund(@Param('id') id: string) {
    return this.orders.refund(id);
  }

  /** Tracking details are optional — see ShipOrderDto for why. */
  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @HttpCode(200)
  @Post(':id/ship')
  ship(@Param('id') id: string, @Body() dto: ShipOrderDto) {
    return this.orders.ship(id, dto);
  }

  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @HttpCode(200)
  @Post(':id/deliver')
  deliver(@Param('id') id: string) {
    return this.orders.deliver(id);
  }
}
