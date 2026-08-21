import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'From the reset e-mail. Single-use, expires after 1 hour.',
  })
  @IsString()
  @IsNotEmpty()
  token!: string;

  /** Same policy as registration — see docs/security.md. */
  @ApiProperty({
    minLength: 8,
    maxLength: 128,
    description:
      'Same policy as registration. Setting it revokes every existing session, not just the current one.',
  })
  @IsString()
  @Length(8, 128)
  newPassword!: string;
}
