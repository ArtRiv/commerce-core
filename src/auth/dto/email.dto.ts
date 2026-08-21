import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/** Body of /auth/resend-verification and /auth/forgot-password. */
export class EmailDto {
  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  @IsEmail()
  email!: string;
}
