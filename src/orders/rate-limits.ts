/**
 * Rate limits for the two order routes that reach the payment provider, from
 * docs/specs/payments.md. Same reasoning as auth's rate-limits.ts: the numbers
 * live together so they can be compared against each other and the spec.
 */

const MINUTE = 60_000;

export const RATE_LIMITS = {
  /**
   * Issuing a payment session creates an object at the provider, so an
   * unbounded loop here is someone else's rate limit being burned through as
   * well as ours. Ten a minute is far above any honest retry: a buyer clicks
   * "pay" again after a failure, not thirty times.
   */
  ISSUE_PAYMENT: { limit: 10, ttl: MINUTE },

  /**
   * The webhook is different from the others, so its limit is different — the
   * same argument auth makes for /refresh. There is nothing to guess in an
   * HMAC, so this is not a brute-force limit, only anti-flood, and it must sit
   * far above a sales spike: an account can emit a lot of events at once.
   *
   * A 429 here also costs less than one anywhere else, because Stripe redelivers
   * with backoff for days — refusing an event postpones it rather than losing it.
   */
  PAYMENT_WEBHOOK: { limit: 300, ttl: MINUTE },
} as const;
