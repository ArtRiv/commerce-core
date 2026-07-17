import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  /**
   * Length policy only, no composition rules — see docs/security.md. The 128
   * ceiling is not a strength requirement; it stops a multi-megabyte body from
   * turning argon2 into a CPU sink.
   */
  @IsString()
  @Length(8, 128)
  password!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}
