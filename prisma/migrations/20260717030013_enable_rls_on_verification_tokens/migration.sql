-- RLS does not inherit: a new table arrives with it disabled, which means
-- exposed to `anon` over PostgREST from the moment it exists.
-- verification_tokens holds the digests authorising email verification and
-- password resets, so leaving it open would hand out account takeover to
-- anyone with the (public) anon key.
--
-- Deny-all, no policies, same as every other table — see
-- 20260717002748_enable_row_level_security. Every new table needs its own.
ALTER TABLE "verification_tokens" ENABLE ROW LEVEL SECURITY;
