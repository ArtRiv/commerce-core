import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../auth/authz/permissions';
import { RequirePermissions } from '../auth/authz/require-permissions.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { CheckoutDto } from './dto/checkout.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { OrdersService } from './orders.service';

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

  /** Checkout: converts the caller's cart into an order. */
  @Post()
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutDto) {
    return this.orders.checkout(user.id, dto.shippingAddress);
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

  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @HttpCode(200)
  @Post(':id/ship')
  ship(@Param('id') id: string) {
    return this.orders.ship(id);
  }

  @RequirePermissions(PERMISSIONS.ORDERS_UPDATE_STATUS)
  @HttpCode(200)
  @Post(':id/deliver')
  deliver(@Param('id') id: string) {
    return this.orders.deliver(id);
  }
}
