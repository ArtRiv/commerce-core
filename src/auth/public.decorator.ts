import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public_route';

/**
 * Opts a route out of authentication. Authentication is on by default because
 * `JwtAuthGuard` is registered globally (see `AuthModule`) — forgetting this
 * decorator makes a route private, which is the safe way to be wrong.
 *
 * @example
 *   @Public()
 *   @Post('login')
 *   login() { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
