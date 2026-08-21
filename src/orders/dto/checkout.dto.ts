import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  CHECKOUT_MODES,
  type CheckoutMode,
} from '../../payments/payment-provider';
import { POSTAL_CODE_PATTERN } from '../../shipping/shipping-table';

/**
 * Free-form address lines on purpose: v1 ships to Brazil and validates shape,
 * not postal semantics. The postal code is the exception, and now a strict
 * one — it is the input freight is priced from, so a malformed CEP is a
 * malformed request (400) rather than something to discover as "we don't
 * deliver there" (409) further down. The order stores all of this as a
 * denormalized snapshot.
 */
export class ShippingAddressDto {
  @ApiProperty({ maxLength: 200, example: 'Rua das Flores, 100' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  line1: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'Apto 42' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiProperty({ maxLength: 100, example: 'Curitiba' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @ApiProperty({ maxLength: 100, example: 'PR' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state: string;

  @ApiProperty({
    description:
      'The only field here that prices anything. City and state are for the label; freight is quoted from the CEP alone.',
    example: '80000-000',
  })
  @Matches(POSTAL_CODE_PATTERN, {
    message: 'postalCode must be a CEP, e.g. 80000-000',
  })
  postalCode: string;
}

export class CheckoutDto {
  @ApiProperty({
    type: ShippingAddressDto,
    description:
      'Stored as a denormalized snapshot on the order — there is no address book in v1.',
  })
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
  @ApiPropertyOptional({
    enum: CHECKOUT_MODES,
    description:
      'Which checkout UI to issue. Defaults to the deployment setting, so one instance can serve a web storefront rendering its own checkout and a mobile app opening the hosted one.',
  })
  @IsOptional()
  @IsIn(CHECKOUT_MODES)
  paymentMode?: CheckoutMode;

  /** The `code` of an option returned by POST /shipping/quote. */
  @ApiProperty({
    maxLength: 100,
    description: 'The `code` of an option returned by POST /shipping/quote.',
    example: 'padrao-sudeste',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  shippingOptionCode: string;

  /**
   * The freight price the customer was SHOWN — an assertion, not an
   * instruction. The server re-quotes and charges its own number; this one is
   * only ever compared against it, and a mismatch is a 409 asking for a fresh
   * quote.
   *
   * Both halves of that matter. Trusting a client-sent price would accept
   * `0`; recomputing silently without comparing would charge someone a price
   * they never saw. See docs/specs/shipping.md.
   */
  @ApiProperty({
    minimum: 0,
    description:
      'The freight price the customer was SHOWN — an assertion, not an instruction. The server re-quotes and charges its own number; this one is only compared against it, and a mismatch is a 409 carrying fresh options. Both halves matter: trusting a client price would accept 0, and recomputing without comparing would charge someone a price they never saw.',
    example: 2490,
  })
  @IsInt()
  @Min(0)
  quotedShippingCents: number;
}
