import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  /** Same policy as registration — see docs/security.md. */
  @IsString()
  @Length(8, 128)
  newPassword!: string;
}
