import type { MailService } from '../../src/mail/mail.service';

interface SentEmail {
  to: string;
  token: string;
}

/**
 * Records mail instead of sending it.
 *
 * Doubles as the test's inbox: the verification and reset flows are only
 * completable by reading the token out of the message, which is exactly what a
 * real user does. That keeps the e2e honest — nothing reaches into the database
 * for a token the API never handed out.
 */
export class FakeMailService implements MailService {
  readonly verificationEmails: SentEmail[] = [];
  readonly passwordResetEmails: SentEmail[] = [];

  /** Set to make the next send fail, for the provider-outage case. */
  failNextSend = false;

  sendVerificationEmail(to: string, token: string): Promise<void> {
    return this.record(this.verificationEmails, { to, token });
  }

  sendPasswordResetEmail(to: string, token: string): Promise<void> {
    return this.record(this.passwordResetEmails, { to, token });
  }

  lastVerificationToken(): string {
    return this.last(this.verificationEmails);
  }

  lastPasswordResetToken(): string {
    return this.last(this.passwordResetEmails);
  }

  reset(): void {
    this.verificationEmails.length = 0;
    this.passwordResetEmails.length = 0;
    this.failNextSend = false;
  }

  private record(into: SentEmail[], email: SentEmail): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;

      return Promise.reject(new Error('Mail provider is down'));
    }

    into.push(email);

    return Promise.resolve();
  }

  private last(emails: SentEmail[]): string {
    const email = emails.at(-1);

    if (!email) {
      throw new Error('No such email was sent');
    }

    return email.token;
  }
}
