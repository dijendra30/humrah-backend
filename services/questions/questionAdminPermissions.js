// services/questions/questionAdminPermissions.js
// -----------------------------------------------------------------------------
// Who may do what in the Ask a Question admin section.
//
// Humrah's admin system is role-based: SAFETY_ADMIN and SUPER_ADMIN (models/User.js,
// middleware/auth.js adminOnly / superAdminOnly; the legacy 'moderator' and 'admin' roles
// map onto them the way those middlewares already treat them). The permissions below are
// the brief's list, given to roles in ONE place. The server checks them on every admin
// route; the dashboard only uses them to decide which buttons to show.
//
//   SAFETY_ADMIN  view, analytics, review reports, moderate, hide/restore/close content,
//                 apply and lift time-limited question restrictions (1 h … 4 days)
//   SUPER_ADMIN   all of that, plus: the final (admin-controlled) restriction and lifting it,
//                 resetting a restriction ladder, deleting content, exporting data
// -----------------------------------------------------------------------------
'use strict';

const PERMS = Object.freeze({
  VIEW_QUESTIONS:            'VIEW_QUESTIONS',
  VIEW_ANALYTICS:            'VIEW_ANALYTICS',
  REVIEW_REPORTS:            'REVIEW_REPORTS',
  MODERATE_CONTENT:          'MODERATE_CONTENT',
  HIDE_CONTENT:              'HIDE_CONTENT',              // hide, restore, close
  DELETE_CONTENT:            'DELETE_CONTENT',            // soft delete
  APPLY_RESTRICTIONS:        'APPLY_RESTRICTIONS',        // levels 1–4, lift a time-limited one
  MANAGE_FINAL_RESTRICTIONS: 'MANAGE_FINAL_RESTRICTIONS', // level 5 (final), lift it, reset the ladder
  EXPORT_DATA:               'EXPORT_DATA',
});

const SAFETY = [PERMS.VIEW_QUESTIONS, PERMS.VIEW_ANALYTICS, PERMS.REVIEW_REPORTS, PERMS.MODERATE_CONTENT, PERMS.HIDE_CONTENT, PERMS.APPLY_RESTRICTIONS];
const SUPER = Object.values(PERMS);

const ROLE_PERMS = Object.freeze({
  SUPER_ADMIN: SUPER,
  admin:       SUPER,          // legacy, treated as super admin by superAdminOnly
  SAFETY_ADMIN: SAFETY,
  moderator:   SAFETY,         // legacy, treated as an admin by adminOnly
});

const permissionsOf = user => [...(ROLE_PERMS[user && user.role] || [])];
const can = (user, perm) => permissionsOf(user).includes(perm);

/** Route guard: 403 ADMIN_PERMISSION_REQUIRED unless the admin's role grants `perm`. */
const requireQuestionPermission = perm => (req, res, next) => {
  if (!req.user || !can(req.user, perm)) {
    return res.status(403).json({ success: false, code: 'ADMIN_PERMISSION_REQUIRED', permission: perm, message: 'You don’t have permission for this action.' });
  }
  return next();
};

module.exports = { PERMS, ROLE_PERMS, permissionsOf, can, requireQuestionPermission };
