/**
 * Addresses are matched case-insensitively. Postgres unique indexes are not,
 * so without this "Ada@example.com" and "ada@example.com" would be two accounts
 * for one mailbox — and Google, which hands back a lowercased address, would
 * fail to auto-link to a mixed-case row.
 *
 * It lives in its own file because a second caller arrived: the staff lookup
 * (`GET /staff?email=`) matches on equality against a column that only ever
 * holds normalized addresses, so a second copy of this rule would mean the
 * owner types the address the way their employee wrote it and finds nobody.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
