/**
 * Rate limits for the sensitive auth routes, from docs/specs/auth.md.
 *
 * Defaults, not laws — the spec says to revisit them with real traffic. They
 * live here rather than inline on the handlers so the numbers can be compared
 * against each other and against the spec in one place.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RATE_LIMITS = {
  /** Credential guessing. Applied per IP *and* per account. */
  LOGIN: { limit: 5, ttl: 15 * MINUTE },

  /** Bulk account creation from one source. */
  REGISTER: { limit: 5, ttl: HOUR },

  /**
   * Mail sent to an address the caller does not own. The limit is low because
   * the abuse here is not against us — it is using our mail reputation to flood
   * someone else's inbox.
   */
  EMAIL_DISPATCH: { limit: 3, ttl: HOUR },

  /** Refresh is cheap, but it is still a credential endpoint. */
  REFRESH: { limit: 30, ttl: 15 * MINUTE },
} as const;
