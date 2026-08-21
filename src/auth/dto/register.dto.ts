import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  @IsEmail()
  email!: string;

  /**
   * Length policy only, no composition rules — see docs/security.md. The 128
   * ceiling is not a strength requirement; it stops a multi-megabyte body from
   * turning argon2 into a CPU sink.
   */
  @ApiProperty({
    minLength: 8,
    maxLength: 128,
    description:
      'Length policy only — no forced uppercase, digit or symbol. Composition rules push people towards predictable passwords, and OWASP advises against them. The 128 ceiling is DoS protection for the hashing, not a strength rule.',
    example: 'correct horse battery staple',
  })
  @IsString()
  @Length(8, 128)
  password!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @IsNotEmpty()
  name!: string;
}
