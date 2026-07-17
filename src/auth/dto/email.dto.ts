import { IsEmail } from 'class-validator';

/** Body of /auth/resend-verification and /auth/forgot-password. */
export class EmailDto {
  @IsEmail()
  email!: string;
}
