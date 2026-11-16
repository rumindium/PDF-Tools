import { APP_PERMISSIONS, type MeBody } from '@pdftools/contracts/api';

/**
 * Who may open the app's administration area (`docs/0-TENANT-FIRST.md` §6).
 *
 * Permissions rather than a role name, and that is the whole point of the arrangement: the platform's app management
 * defines what `admin` means and can re-cut it at any time. A client that tested `appRoles.includes('admin')` would
 * disagree with the API the first time somebody renamed the role or moved the permission to another one — and the
 * disagreement would show up as a menu item that 403s.
 *
 * The three questions below are separate because the two permissions are separate: opening the dashboard and running
 * a maintenance action are different acts, and an app that conflated them could not later lend the first to somebody
 * who should not have the second.
 */
export function canOpenAdmin(me: MeBody | null | undefined): boolean {
  return me?.appPermissions?.includes(APP_PERMISSIONS.adminRead) ?? false;
}

export function canOperateApp(me: MeBody | null | undefined): boolean {
  return me?.appPermissions?.includes(APP_PERMISSIONS.adminOperate) ?? false;
}

/**
 * What to tell somebody who reached the area without the permission.
 *
 * Three states, and they need different sentences: no account at all (offer a sign-in), an account with no roles
 * (tell them who can grant it), and an installation whose roles could not be read (say so instead of blaming the
 * person, because "you are not an administrator" would be a claim made without evidence).
 */
export function adminRefusal(me: MeBody | null | undefined): { title: string; message: string; signIn: boolean } {
  if (!me || me.kind === 'guest') {
    return {
      title: 'This area needs an account',
      message:
        'App administration is available to accounts an administrator has granted the admin role. Sign in first.',
      signIn: true,
    };
  }
  if ((me.appPermissions?.length ?? 0) === 0 && (me.appRoles?.length ?? 0) === 0 && me.planSource === 'account') {
    return {
      title: 'No admin role on this account',
      message:
        'The workspace did not answer with any app roles for this account, so there is nothing to open. An administrator of this app grants the admin role from Auth Platform.',
      signIn: false,
    };
  }
  return {
    title: 'You are not an administrator of this app',
    message: 'Ask an administrator of PDF Tools for the admin role, from Auth Platform’s app management.',
    signIn: false,
  };
}
