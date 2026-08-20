import { IsString, Matches } from 'class-validator';

import { POSTAL_CODE_PATTERN } from '../../shipping/shipping-table';

export class ShippingQuoteDto {
  /**
   * The destination CEP, with or without the hyphen. It is the only input a
   * quote needs: in Brazil the postal code determines city and state, and it
   * is what carriers price against.
   */
  @IsString()
  @Matches(POSTAL_CODE_PATTERN, {
    message: 'postalCode must be a CEP, e.g. 80000-000',
  })
  postalCode!: string;
}
