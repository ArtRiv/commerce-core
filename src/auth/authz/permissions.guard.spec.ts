import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedUser } from '../authenticated-user';
import { type Permission, PERMISSIONS } from './permissions';
import { PermissionsGuard } from './permissions.guard';

function contextWith(user?: AuthenticatedUser): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWith(required: Permission[] | undefined): PermissionsGuard {
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;

  return new PermissionsGuard(reflector);
}

function userWith(permissions: Permission[]): AuthenticatedUser {
  return { id: 'user-1', role: 'operator', permissions: new Set(permissions) };
}

describe('PermissionsGuard', () => {
  describe('routes without @RequirePermissions', () => {
    // Regression: Reflector is typed as returning `T`, but returns undefined
    // when no metadata is set. A lint autofix once removed the undefined check,
    // which crashed every unannotated route once the guard went global.
    it('allows a route whose metadata is undefined', () => {
      expect(guardWith(undefined).canActivate(contextWith())).toBe(true);
    });

    it('allows a route with an empty permission list', () => {
      expect(guardWith([]).canActivate(contextWith())).toBe(true);
    });
  });

  describe('routes with @RequirePermissions', () => {
    it('rejects an unauthenticated request', () => {
      const guard = guardWith([PERMISSIONS.ORDERS_REFUND]);

      expect(() => guard.canActivate(contextWith())).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a user missing a required permission', () => {
      const guard = guardWith([PERMISSIONS.ORDERS_REFUND]);
      const context = contextWith(userWith([PERMISSIONS.ORDERS_READ]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('requires every listed permission, not just one (AND semantics)', () => {
      const guard = guardWith([
        PERMISSIONS.ORDERS_READ,
        PERMISSIONS.ORDERS_REFUND,
      ]);
      const context = contextWith(userWith([PERMISSIONS.ORDERS_READ]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('allows a user holding every required permission', () => {
      const guard = guardWith([
        PERMISSIONS.ORDERS_READ,
        PERMISSIONS.ORDERS_REFUND,
      ]);
      const context = contextWith(
        userWith([PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_REFUND]),
      );

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
