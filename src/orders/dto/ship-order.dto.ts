import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * Tracking is optional, and that is a business rule rather than laziness: a
 * local delivery — a courier, a hand-off arranged by phone — is a real
 * shipment with no code to give, and requiring one would block it. See
 * docs/specs/shipping.md.
 */
export class ShipOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  trackingCode?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  trackingUrl?: string;
}
