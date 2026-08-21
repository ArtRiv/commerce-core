import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * Tracking is optional, and that is a business rule rather than laziness: a
 * local delivery — a courier, a hand-off arranged by phone — is a real
 * shipment with no code to give, and requiring one would block it. See
 * docs/specs/shipping.md.
 */
export class ShipOrderDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Optional by business rule, not by omission: a local courier hand-off is a real shipment with no code to quote.',
    example: 'BR123456789BR',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  trackingCode?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    format: 'uri',
    example: 'https://rastreamento.correios.com.br/BR123456789BR',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2000)
  trackingUrl?: string;
}
