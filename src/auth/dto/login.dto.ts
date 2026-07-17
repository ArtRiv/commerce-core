import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  /**
   * Deliberately not `@Length(8, 128)` like RegisterDto. The 8-character
   * minimum is a registration policy; enforcing it here would answer a short
   * password with 400 instead of the 401 every other bad credential gets,
   * which tells an attacker their guess was rejected by a rule rather than by
   * the account. The ceiling stays — that one is DoS protection and says
   * nothing about the account.
   */
  @IsString()
  @MaxLength(128)
  password!: string;
}
