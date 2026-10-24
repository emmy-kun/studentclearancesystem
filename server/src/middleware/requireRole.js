import httpError from '../utils/httpError.js';

export const REVIEWER_ROLES = ['departmental', 'faculty', 'library', 'alumni', 'student_affairs', 'security', 'audit'];

/** Allow only the listed roles. Use after requireAuth. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) throw httpError(403, 'You do not have access to this resource');
    next();
  };
}

export const requireStudent = requireRole('student');
export const requireAdmin = requireRole('admin');
export const requireReviewer = requireRole(...REVIEWER_ROLES);

/**
 * Scope rule (spec section 2 / 7): may this user act on a student with the given
 * department_id and faculty_id?
 *   departmental -> same department; faculty -> same faculty;
 *   central offices, audit and admin -> all students; students -> only themselves.
 */
export function inScope(user, student) {
  switch (user.role) {
    case 'student':
      return user.sub === student.student_id;
    case 'departmental':
      return user.department_id != null && user.department_id === student.department_id;
    case 'faculty':
      return user.faculty_id != null && user.faculty_id === student.faculty_id;
    case 'library':
    case 'alumni':
    case 'student_affairs':
    case 'security':
    case 'audit':
    case 'registry':
    case 'admin':
      return true;
    default:
      return false;
  }
}

/** Throws 403 unless inScope(). */
export function assertInScope(user, student) {
  if (!inScope(user, student)) throw httpError(403, 'This student is outside your scope');
}
