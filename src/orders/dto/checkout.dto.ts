import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  CHECKOUT_MODES,
  type CheckoutMode,
} from '../../payments/payment-provider';

/**
 * Free-form address lines on purpose: v1 ships to Brazil but validates shape,
 * not postal semantics — CEP lookup and carrier validation belong to the
 * shipping module. The order stores this as a denormalized snapshot.
 */
export class ShippingAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  line1: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  postalCode: string;
}

export class CheckoutDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress: ShippingAddressDto;

  /**
   * Which checkout UI the storefront wants. Optional: the deployment picks a
   * default (STRIPE_CHECKOUT_MODE), and a request may override it — so one
   * instance can serve a web storefront rendering its own checkout page and a
   * mobile app opening the provider's hosted one.
   */
  @IsOptional()
  @IsIn(CHECKOUT_MODES)
  paymentMode?: CheckoutMode;
}
