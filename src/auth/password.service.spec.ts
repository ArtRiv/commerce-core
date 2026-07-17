import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  describe('hash', () => {
    it('produces an argon2id hash', async () => {
      expect(await service.hash('correct horse battery staple')).toMatch(
        /^\$argon2id\$/,
      );
    });

    it('salts, so the same password never yields the same hash twice', async () => {
      const [first, second] = await Promise.all([
        service.hash('same password'),
        service.hash('same password'),
      ]);

      expect(first).not.toBe(second);
    });
  });

  describe('verify', () => {
    it('accepts the password it was hashed from', async () => {
      const hash = await service.hash('correct horse battery staple');

      expect(await service.verify(hash, 'correct horse battery staple')).toBe(
        true,
      );
    });

    it('rejects a wrong password', async () => {
      const hash = await service.hash('correct horse battery staple');

      expect(await service.verify(hash, 'Tr0ub4dor&3')).toBe(false);
    });

    it('rejects when there is no hash to verify against', async () => {
      expect(await service.verify(null, 'any password')).toBe(false);
    });

    // The security property, not an implementation detail. A Google-only
    // account has no passwordHash, and an unknown email has no user at all.
    // Returning false early in either case answers in ~1ms where a real
    // verification takes ~100ms, and that gap is an account-enumeration oracle
    // — it tells an attacker which addresses are registered with a password,
    // silently undoing the generic error message the spec insists on. So the
    // no-hash path must still pay argon2's cost against a dummy hash.
    it('spends comparable time when there is no hash (no timing oracle)', async () => {
      const hash = await service.hash('correct horse battery staple');

      const realStart = performance.now();
      await service.verify(hash, 'wrong password');
      const realElapsed = performance.now() - realStart;

      const nullStart = performance.now();
      await service.verify(null, 'wrong password');
      const nullElapsed = performance.now() - nullStart;

      // Deliberately loose: this asserts the same order of magnitude, not a
      // constant-time guarantee. A tight bound would flake on a noisy machine,
      // and the failure being caught here is "returns instantly", not "leaks
      // 3ms".
      expect(nullElapsed).toBeGreaterThan(realElapsed * 0.5);
    });
  });
});
