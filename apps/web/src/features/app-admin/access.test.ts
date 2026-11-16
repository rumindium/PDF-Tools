import { describe, expect, test } from 'bun:test';
import type { MeBody } from '@pdftools/contracts/api';
import { adminRefusal, canOpenAdmin, canOperateApp } from './access';

/**
 * The menu's half of the admin gate (`docs/0-TENANT-FIRST.md` §6).
 *
 * The cases below are the ones a bundle gets wrong: reading the permission rather than the role name, keeping the two
 * permissions apart, and — the one that matters most — treating a missing answer as *nothing* rather than as
 * everything. A gate that opened when the platform was unreachable would be an open door with a lock on it.
 */

function me(overrides: Partial<MeBody>): MeBody {
  return {
    kind: 'user',
    userId: 'u1',
    tenantId: 't1',
    displayName: 'Siti A.',
    planId: 'free',
    planName: 'Free',
    entitlements: { maxFileMb: 50, maxJobMb: 100, maxPages: 20, maxFiles: 5, queuePriority: 10 },
    quota: { used: 0, limit: 20, windowSeconds: 86_400, resetsAt: new Date().toISOString(), planId: 'free' },
    ...overrides,
  } as MeBody;
}

describe('canOpenAdmin', () => {
  test('the permission is what opens it, not the role name', () => {
    // A caller holding a role called `admin` that does not carry `pdftools.admin.read` must not get the door: the
    // platform is free to re-cut what that name means, and the code is the contract.
    expect(canOpenAdmin(me({ appRoles: ['admin'], appPermissions: [] }))).toBe(false);
    expect(canOpenAdmin(me({ appRoles: ['something-else'], appPermissions: ['pdftools.admin.read'] }))).toBe(true);
  });

  test('a missing answer grants nothing', () => {
    expect(canOpenAdmin(null)).toBe(false);
    expect(canOpenAdmin(undefined)).toBe(false);
    expect(canOpenAdmin(me({ kind: 'anonymous', appRoles: [], appPermissions: [] }))).toBe(false);
    expect(canOpenAdmin(me({ kind: 'guest', userId: null, appRoles: [], appPermissions: [] }))).toBe(false);
  });
});

describe('canOperateApp', () => {
  test('reading the dashboard is not the same as running maintenance', () => {
    const reader = me({ appRoles: ['admin'], appPermissions: ['pdftools.admin.read'] });
    const operator = me({ appRoles: ['admin'], appPermissions: ['pdftools.admin.read', 'pdftools.admin.operate'] });

    expect(canOpenAdmin(reader)).toBe(true);
    expect(canOperateApp(reader)).toBe(false);
    expect(canOperateApp(operator)).toBe(true);
  });
});

describe('adminRefusal', () => {
  test('a guest is offered a sign-in, and nothing else is', () => {
    const guest = adminRefusal(me({ kind: 'guest', userId: null, appRoles: [], appPermissions: [] }));
    expect(guest.signIn).toBe(true);
    expect(adminRefusal(null).signIn).toBe(true);

    const member = adminRefusal(me({ appRoles: ['user'], appPermissions: [] }));
    expect(member.signIn).toBe(false);
    expect(member.title.toLowerCase()).toContain('not an administrator');
  });

  test('an account with no roles at all is told the difference', () => {
    // `planSource: 'account'` with nothing beside it is the third state: the workspace did not answer with roles for
    // this account, so there is nothing to grant or refuse locally — and the sentence says that rather than blaming
    // the person for lacking a role nobody confirmed.
    const refusal = adminRefusal(me({ appRoles: [], appPermissions: [], planSource: 'account' }));
    expect(refusal.title.toLowerCase()).toContain('no admin role');
  });
});
