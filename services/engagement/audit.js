// services/engagement/audit.js
// Writes engagement admin actions to the shared AuditLog (the same helper and shape the
// App Update module uses). Never throws: an audit failure is logged, the action stands.
'use strict';

const AuditLog = require('../../models/AuditLog');
const log = require('./log');

async function audit(admin, action, targetType, targetId, { reason = null, details = null, before = null, after = null, req = null } = {}) {
  if (!admin || !admin._id) return null;
  const entry = await AuditLog.logAction({
    actorId: admin._id, actorRole: admin.role, actorEmail: admin.email || 'unknown',
    action, targetType, targetId: targetId || undefined,
    reason: reason || undefined, details: details || {},
    previousState: before || undefined, newState: after || undefined,
    ipAddress: req ? req.ip : undefined, userAgent: req ? req.get('user-agent') : undefined,
    requestMethod: req ? req.method : undefined, requestPath: req ? String(req.originalUrl || '').split('?')[0] : undefined,
  });
  if (!entry) log.error('audit_write_failed', { action });
  return entry;
}

module.exports = { audit };
