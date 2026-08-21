import { ApiProperty } from '@nestjs/swagger';

/**
 * What every successful sign-in hands back.
 *
 * Both fields are credentials. The access token is short-lived (15 minutes)
 * and is what goes in the Authorization header; the refresh token lasts 7
 * days, is single-use, and is the only way to get a new pair without asking
 * for the password again. Store the refresh token where a stolen one would
 * cost the most to obtain — re-presenting a spent one is treated as theft and
 * revokes the entire session family.
 */
export class TokenPairResponse {
  @ApiProperty({
    description:
      'Bearer token for the Authorization header. Expires in 15 minutes.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>',
  })
  accessToken: string;

  @ApiProperty({
    description:
      'Single-use token for POST /auth/refresh. Valid for 7 days; each use issues a new one and invalidates this one.',
    example: '3f1c1e0a…',
  })
  refreshToken: string;
}
