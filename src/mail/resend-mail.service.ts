import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

import type { MailService } from './mail.service';

@Injectable()
export class ResendMailService implements MailService {
  private readonly logger = new Logger(ResendMailService.name);
  private readonly resend: Resend;
  private readonly from: string;
  private readonly appUrl: string;

  constructor(config: ConfigService) {
    // getOrThrow: a mail provider with no key is not a degraded app, it is a
    // broken one — email verification gates every password login. Failing at
    // boot beats discovering it when the first user cannot sign in.
    this.resend = new Resend(config.getOrThrow<string>('RESEND_API_KEY'));
    this.from = config.getOrThrow<string>('MAIL_FROM');
    // The frontend base, not this API. These links are opened in a browser and
    // land on pages (`/verify-email?token=`, `/reset-password?token=`) that
    // read the token and POST it back to the matching /auth endpoint. Pointing
    // this at the API would send users to a 404 — the API route is a POST at a
    // different path.
    this.appUrl = config.getOrThrow<string>('APP_URL');
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const link = this.link('/verify-email', token);

    await this.send({
      to,
      subject: 'Confirme seu e-mail',
      html: `<p>Confirme seu e-mail para ativar sua conta:</p>
             <p><a href="${link}">Confirmar e-mail</a></p>
             <p>O link expira em 24 horas.</p>`,
    });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const link = this.link('/reset-password', token);

    await this.send({
      to,
      subject: 'Redefinir sua senha',
      html: `<p>Recebemos um pedido para redefinir sua senha:</p>
             <p><a href="${link}">Redefinir senha</a></p>
             <p>O link expira em 1 hora. Se não foi você, ignore este e-mail.</p>`,
    });
  }

  private link(path: string, token: string): string {
    return `${this.appUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  private async send(message: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      ...message,
    });

    // Resend reports failures in the response rather than by throwing, so an
    // unchecked call looks successful no matter what happened.
    if (error) {
      // The message is logged, never the token — logs are not a safe place for
      // a live credential, which is the whole reason the DB only stores hashes.
      this.logger.error(
        `Resend rejected a "${message.subject}" email: ${error.message}`,
      );

      throw new Error(`Failed to send email: ${error.message}`);
    }
  }
}
