import pool from '../config/db.js';

/**
 * Record a state change in audit_logs. Pass the transaction connection as `db`
 * so the log entry commits or rolls back with the change it describes.
 *
 * @param {object} entry { actorType: 'student'|'staff'|'system', actorId, action, entity, entityId, detail }
 */
export async function logAudit({ actorType, actorId = null, action, entity, entityId = null, detail = null }, db = pool) {
  await db.query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [actorType, actorId, action, entity, entityId, detail === null ? null : JSON.stringify(detail)]
  );
}

/** Convenience: audit entry for the authenticated user on this request. */
export function actorFrom(user) {
  return { actorType: user.userType, actorId: user.sub };
}
