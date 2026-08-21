import { ApiProperty } from '@nestjs/swagger';

/**
 * Deliberately just an identity. Registration does not sign anyone in — the
 * account starts unverified and password login stays closed until the e-mailed
 * link is followed — so there is no token to return and nothing else a client
 * needs at this point.
 */
export class RegisteredUserResponse {
  @ApiProperty({
    format: 'uuid',
    example: '9b2f4a1e-0c33-4d7b-9f10-2a5c8e6d41bb',
  })
  id: string;

  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  email: string;
}
