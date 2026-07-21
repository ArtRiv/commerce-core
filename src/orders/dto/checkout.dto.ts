import { Type } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

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
}
