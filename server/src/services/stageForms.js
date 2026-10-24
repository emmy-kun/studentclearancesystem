// Stage-level input fields stored in clearance_stages.form_data (spec section 6).
// Saving accepts a partial draft (types checked, unknown keys dropped); the
// required fields are only enforced when the stage is submitted.
import httpError from '../utils/httpError.js';

const MAX_TEXT = 120;

export const STAGE_FORMS = {
  library: {
    fields: { library_registered: 'boolean' },
    required: () => ['library_registered'],
  },
  student_affairs: {
    fields: {
      accommodation_type: ['on_campus', 'off_campus'],
      hostel_name: 'text',
      block: 'text',
      room_no: 'text',
      bed_space: 'text',
      off_campus_address: 'text',
    },
    required: (d) =>
      d.accommodation_type === 'off_campus'
        ? ['accommodation_type', 'off_campus_address']
        : ['accommodation_type', 'hostel_name', 'room_no'],
  },
  letter: {
    fields: { page_no: 'integer', serial_no: 'text' },
    required: () => ['page_no'],
  },
  security: {
    fields: { full_name: 'text', matric_no: 'text', department: 'text', phone: 'text', hostel_or_address: 'text' },
    required: () => ['full_name', 'matric_no', 'department', 'phone', 'hostel_or_address'],
  },
};

export const FIELD_LABELS = {
  library_registered: 'Library registration',
  accommodation_type: 'Accommodation type',
  hostel_name: 'Hostel name',
  room_no: 'Room number',
  off_campus_address: 'Off-campus address',
  full_name: 'Full name',
  matric_no: 'Reg number',
  department: 'Department',
  phone: 'Phone number',
  hostel_or_address: 'Hostel or address',
  page_no: 'Page your name is on',
  serial_no: 'Your number on the list',
};

export const hasForm = (stageKey) => Boolean(STAGE_FORMS[stageKey]);

/** Validate and clean form input for a stage. Throws 400 on bad types. */
export function sanitizeForm(stageKey, input) {
  const def = STAGE_FORMS[stageKey];
  if (!def) throw httpError(400, 'This stage has no form to fill');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Form data must be an object');

  const out = {};
  for (const [key, type] of Object.entries(def.fields)) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    if (type === 'boolean') {
      if (typeof value !== 'boolean') throw httpError(400, `${FIELD_LABELS[key] || key} must be true or false`);
      out[key] = value;
    } else if (type === 'integer') {
      const n = Number(String(value).trim());
      if (!Number.isInteger(n) || n < 1 || n > 10000) throw httpError(400, `${FIELD_LABELS[key] || key} must be a whole number`);
      out[key] = n;
    } else if (Array.isArray(type)) {
      if (!type.includes(value)) throw httpError(400, `${FIELD_LABELS[key] || key} must be one of: ${type.join(', ')}`);
      out[key] = value;
    } else {
      const text = String(value).replace(/\s+/g, ' ').trim();
      if (text.length > MAX_TEXT) throw httpError(400, `${FIELD_LABELS[key] || key} is too long (max ${MAX_TEXT} characters)`);
      if (text) out[key] = text;
    }
  }
  return out;
}

/** Names of required fields that are still empty. */
export function missingFormFields(stageKey, data) {
  const def = STAGE_FORMS[stageKey];
  if (!def) return [];
  const d = data || {};
  return def.required(d).filter((k) => d[k] === undefined || d[k] === null || d[k] === '');
}
