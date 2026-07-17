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

  /**
   * Refresh is different from the others, so its limit is different. A refresh
   * token is 256 bits of CSPRNG output stored as a hash — there is nothing to
   * guess, so this is not a credential-guessing limit like login's. Its only
   * job is to cap raw flooding, so it is generous: a real client refreshes
   * roughly once per access-token lifetime (~15 min), while a strict per-IP
   * number would punish many users behind one NAT for a threat that does not
   * apply here. 60/min per IP stops a flood without touching normal use.
   */
  REFRESH: { limit: 60, ttl: MINUTE },
} as const;
