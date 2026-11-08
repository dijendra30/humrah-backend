// services/appUpdates/appUpdatePermissions.js
// -----------------------------------------------------------------------------
// Who may do what in App Update Management (role-based, like Ask a Question):
//   SAFETY_ADMIN  view releases and analytics
//   SUPER_ADMIN   also create, edit, publish, schedule, pause and withdraw releases —
//                 a release reaches every user, so changing one is super-admin only.
// The server checks these on every route; the dashboard only uses them to hide buttons.
// The role comes from the database user loaded by `authenticate`, never from the client.
// -----------------------------------------------------------------------------
'use strict';

const PERMS = Object.freeze({
  VIEW_APP_UPDATES: 'VIEW_APP_UPDATES',
  MANAGE_APP_UPDATES: 'MANAGE_APP_UPDATES',
});

const ROLE_PERMS = Object.freeze({
  SUPER_ADMIN: [PERMS.VIEW_APP_UPDATES, PERMS.MANAGE_APP_UPDATES],
  SAFETY_ADMIN: [PERMS.VIEW_APP_UPDATES],
});

const permissionsOf = user => [...(ROLE_PERMS[user && user.role] || [])];
const can = (user, perm) => permissionsOf(user).includes(perm);

const requireAppUpdatePermission = perm => (req, res, next) => {
  if (!req.user || !can(req.user, perm)) {
    return res.status(403).json({ success: false, code: 'ADMIN_PERMISSION_REQUIRED', permission: perm, message: 'You don’t have permission for this action.' });
  }
  return next();
};

module.exports = { PERMS, ROLE_PERMS, permissionsOf, can, requireAppUpdatePermission };
