import { SetMetadata } from '@nestjs/common';

import type { Permission } from './permissions';

export const PERMISSIONS_KEY = 'required_permissions';

export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
