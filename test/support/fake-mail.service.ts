import type {
  MailService,
  OrderEmailData,
  OrderShippedEmailData,
} from '../../src/mail/mail.service';

interface SentEmail {
  to: string;
  token: string;
}

interface SentOrderEmail<TData = OrderEmailData> {
  to: string;
  data: TData;
}

/**
 * Records mail instead of sending it.
 *
 * Doubles as the test's inbox: the verification and reset flows are only
 * completable by reading the token out of the message, which is exactly what a
 * real user does. That keeps the e2e honest — nothing reaches into the database
 * for a token the API never handed out.
 *
 * The order emails record the view model rather than rendered HTML, so an e2e
 * asserts that freight was broken out of the total instead of grepping for a
 * formatted number. How that view model becomes HTML is already pinned down by
 * the template unit tests.
 */
export class FakeMailService implements MailService {
  readonly verificationEmails: SentEmail[] = [];
  readonly passwordResetEmails: SentEmail[] = [];

  readonly orderPaidEmails: SentOrderEmail[] = [];
  readonly orderShippedEmails: SentOrderEmail<OrderShippedEmailData>[] = [];
  readonly orderRefundedEmails: SentOrderEmail[] = [];
  readonly orderCancelledEmails: SentOrderEmail[] = [];

  /** Set to make the next send fail, for the provider-outage case. */
  failNextSend = false;

  sendVerificationEmail(to: string, token: string): Promise<void> {
    return this.record(this.verificationEmails, { to, token });
  }

  sendPasswordResetEmail(to: string, token: string): Promise<void> {
    return this.record(this.passwordResetEmails, { to, token });
  }

  sendOrderPaidEmail(to: string, data: OrderEmailData): Promise<void> {
    return this.record(this.orderPaidEmails, { to, data });
  }

  sendOrderShippedEmail(
    to: string,
    data: OrderShippedEmailData,
  ): Promise<void> {
    return this.record(this.orderShippedEmails, { to, data });
  }

  sendOrderRefundedEmail(to: string, data: OrderEmailData): Promise<void> {
    return this.record(this.orderRefundedEmails, { to, data });
  }

  sendOrderCancelledEmail(to: string, data: OrderEmailData): Promise<void> {
    return this.record(this.orderCancelledEmails, { to, data });
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
    this.orderPaidEmails.length = 0;
    this.orderShippedEmails.length = 0;
    this.orderRefundedEmails.length = 0;
    this.orderCancelledEmails.length = 0;
    this.failNextSend = false;
  }

  private record<T>(into: T[], email: T): Promise<void> {
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
