import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../generated/prisma';
import { SmsAdminController } from './sms-admin.controller';

describe('SmsAdminController authorization', () => {
  const reflector = new Reflector();

  it('requires an admin JWT on the SMS admin controller', () => {
    expect(reflector.get(ROLES_KEY, SmsAdminController)).toEqual([
      UserRole.ADMIN,
    ]);
    const guards = reflector.get(GUARDS_METADATA, SmsAdminController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
  });

  it('rate-limits the flush route', () => {
    const flushHandler = Object.getOwnPropertyDescriptor(
      SmsAdminController.prototype,
      'flush',
    )?.value as object;
    expect(reflector.get(GUARDS_METADATA, flushHandler)).toEqual(
      expect.arrayContaining([AuthRateLimitGuard]),
    );
    expect(reflector.get(ROLES_KEY, SmsAdminController)).toEqual([
      UserRole.ADMIN,
    ]);
  });

  it('rate-limits the test SMS route', () => {
    const testHandler = Object.getOwnPropertyDescriptor(
      SmsAdminController.prototype,
      'test',
    )?.value as object;
    expect(reflector.get(GUARDS_METADATA, testHandler)).toEqual(
      expect.arrayContaining([AuthRateLimitGuard]),
    );
  });
});
