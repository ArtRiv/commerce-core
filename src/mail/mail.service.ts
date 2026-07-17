/**
 * Outbound transactional email.
 *
 * An interface behind a token rather than a concrete class so the provider is
 * swappable — tests bind a fake and never touch the network, and replacing
 * Resend later is a module change rather than an AuthService change.
 *
 * Implementations must not throw for a delivery failure that the caller can
 * survive; see AuthService.register and docs/specs/auth.md — a mail outage must
 * not block sign-up.
 */
export interface MailService {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string): Promise<void>;
}

export const MAIL_SERVICE = Symbol('MAIL_SERVICE');
