import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({
    description:
      'From the verification e-mail. Single-use, expires after 24 hours.',
  })
  @IsString()
  @IsNotEmpty()
  token!: string;
}
