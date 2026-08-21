import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** Body of /auth/refresh and /auth/logout. */
export class RefreshTokenDto {
  @ApiProperty({
    description:
      'The refresh token from the last sign-in or refresh. Single-use: re-presenting a spent one revokes the whole session family.',
    example: '3f1c1e0a…',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
