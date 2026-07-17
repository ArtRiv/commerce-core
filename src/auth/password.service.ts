import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Hashing and verification of user passwords. The only place argon2 is touched.
 *
 * Argon2's own defaults are argon2id at m=64MiB, t=3, p=4 — already above the
 * floor in the OWASP Password Storage Cheat Sheet (19MiB, t=2), so they are
 * left alone rather than hand-tuned.
 */
@Injectable()
export class PasswordService {
  /**
   * A hash of a random throwaway string, used to burn time on the no-hash path
   * of `verify`. Computed once per instance; it is not a secret and nothing
   * can match it.
   */
  private readonly dummyHash: Promise<string> = argon2.hash(
    randomBytes(32).toString('hex'),
  );

  hash(plain: string): Promise<string> {
    return argon2.hash(plain);
  }

  /**
   * `hash` is nullable because the caller may have no hash to offer: the email
   * belongs to no account, or to a Google-only one that never set a password.
   *
   * Both cases still run a full argon2 verification, against a dummy hash whose
   * result is thrown away. Returning false immediately would answer in about a
   * millisecond where a real check takes ~100ms, and that difference is
   * measurable from outside — an attacker could tell registered addresses from
   * unregistered ones by timing alone, which is exactly what the spec's
   * deliberately vague "invalid credentials" message exists to prevent.
   */
  async verify(hash: string | null, plain: string): Promise<boolean> {
    const target = hash ?? (await this.dummyHash);
    const matched = await argon2.verify(target, plain);

    return hash === null ? false : matched;
  }
}
