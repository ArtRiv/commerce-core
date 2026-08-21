import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ format: 'email', example: 'ada@example.com' })
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
  @ApiProperty({
    maxLength: 128,
    description:
      'No minimum is enforced here, deliberately: rejecting a short password with 400 would tell an attacker their guess was refused by a rule rather than by the account.',
    example: 'correct horse battery staple',
  })
  @IsString()
  @MaxLength(128)
  password!: string;
}
