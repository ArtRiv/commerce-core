import { IsNotEmpty, IsString } from 'class-validator';

/** Body of /auth/refresh and /auth/logout. */
export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
