-- Automated Student Clearance and Certificate Issuance System
-- MySQL 8 schema. migrate.js replaces `clearance_db` with DB_NAME from .env.

CREATE DATABASE IF NOT EXISTS clearance_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE clearance_db;

CREATE TABLE IF NOT EXISTS faculties (
  faculty_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS departments (
  department_id INT AUTO_INCREMENT PRIMARY KEY,
  faculty_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_dept (faculty_id, name),
  FOREIGN KEY (faculty_id) REFERENCES faculties(faculty_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS students (
  student_id INT AUTO_INCREMENT PRIMARY KEY,
  matric_no VARCHAR(20) NOT NULL UNIQUE,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  department_id INT NOT NULL,                 -- faculty is derived via departments.faculty_id
  levels_count TINYINT NOT NULL DEFAULT 4,    -- 4 or 5 years (100 to final level)
  admission_year YEAR NULL,
  graduation_session VARCHAR(9) NULL,         -- e.g. '2025/2026'
  accommodation_type ENUM('on_campus','off_campus') NOT NULL DEFAULT 'on_campus',
  phone VARCHAR(20) NULL,
  passport_path VARCHAR(255) NULL,
  password_hash VARCHAR(255) NULL,            -- set when the student signs up; NULL = no account yet
  registered_at DATETIME NULL,                -- when the student signed up
  results_released BOOLEAN NOT NULL DEFAULT FALSE, -- legacy: graduation-list verification (stage 7) replaced the release step
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(department_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS staff (
  staff_id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  role ENUM('departmental','faculty','library','alumni','student_affairs','security','audit','registry','admin') NOT NULL,
  department_id INT NULL,                     -- required when role = 'departmental'
  faculty_id INT NULL,                        -- required when role = 'faculty'
  password_hash VARCHAR(255) NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(department_id),
  FOREIGN KEY (faculty_id) REFERENCES faculties(faculty_id)
) ENGINE=InnoDB;
-- Enforced in application code: departmental => department_id set; faculty => faculty_id set.

CREATE TABLE IF NOT EXISTS workflow_stages (
  stage_key VARCHAR(30) PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  reviewer_role ENUM('departmental','faculty','library','alumni','student_affairs','security','audit') NULL, -- NULL for auto stages
  sequence_order TINYINT NOT NULL UNIQUE,
  unlock_rule ENUM('sequential','anytime','on_results_released','all_others_approved') NOT NULL,
  review_mode ENUM('manual','auto') NOT NULL DEFAULT 'manual',
  fee_amount DECIMAL(12,2) NULL,              -- fixed fee in NGN, NULL if none
  is_active BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS required_documents (
  required_doc_id INT AUTO_INCREMENT PRIMARY KEY,
  stage_key VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  per_level BOOLEAN NOT NULL DEFAULT FALSE,   -- repeat once per level 100..final
  applies_if ENUM('always','off_campus','library_registered','library_not_registered') NOT NULL DEFAULT 'always',
  reference_label VARCHAR(60) NULL,           -- label for the reference input (e.g. 'Receipt no.'); NULL = no reference field
  collects_amount BOOLEAN NOT NULL DEFAULT FALSE,
  collects_date BOOLEAN NOT NULL DEFAULT FALSE,
  check_identity BOOLEAN NOT NULL DEFAULT TRUE, -- reviewer must confirm the name + reg number on it; OCR checks images
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  display_order TINYINT NOT NULL DEFAULT 0,
  FOREIGN KEY (stage_key) REFERENCES workflow_stages(stage_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS clearance_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  session VARCHAR(9) NOT NULL,                -- '2025/2026'
  status ENUM('in_progress','completed') NOT NULL DEFAULT 'in_progress',
  initiated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  letter_path VARCHAR(255) NULL,
  UNIQUE KEY uq_student_session (student_id, session),
  FOREIGN KEY (student_id) REFERENCES students(student_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS clearance_stages (
  stage_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  stage_key VARCHAR(30) NOT NULL,
  status ENUM('locked','awaiting_submission','pending','approved','rejected') NOT NULL DEFAULT 'locked',
  form_data JSON NULL,                        -- stage-level input fields (library choice, accommodation details, security details)
  reviewed_by INT NULL,
  comment TEXT NULL,
  unlocked_at DATETIME NULL,
  submitted_at DATETIME NULL,
  reviewed_at DATETIME NULL,
  UNIQUE KEY uq_request_stage (request_id, stage_key),
  FOREIGN KEY (request_id) REFERENCES clearance_requests(request_id),
  FOREIGN KEY (stage_key) REFERENCES workflow_stages(stage_key),
  FOREIGN KEY (reviewed_by) REFERENCES staff(staff_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stage_documents (
  document_id INT AUTO_INCREMENT PRIMARY KEY,
  stage_id INT NOT NULL,
  required_doc_id INT NOT NULL,
  level SMALLINT NOT NULL DEFAULT 0,          -- 100..500 for per_level docs, 0 otherwise (so uq_slot works; NULLs would not)
  file_path VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NULL,
  mime_type VARCHAR(80) NULL,
  reference_no VARCHAR(60) NULL,              -- receipt / teller / RRR number typed by student
  amount DECIMAL(12,2) NULL,
  document_date DATE NULL,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ocr_status ENUM('pending','match','partial','no_match','unreadable','skipped') NULL, -- automatic name/reg-number check
  ocr_result JSON NULL,
  status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  reviewer_note VARCHAR(255) NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_slot (stage_id, required_doc_id, level),
  KEY idx_ref (required_doc_id, reference_no),
  FOREIGN KEY (stage_id) REFERENCES clearance_stages(stage_id),
  FOREIGN KEY (required_doc_id) REFERENCES required_documents(required_doc_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payments (
  payment_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  stage_id INT NOT NULL,
  purpose ENUM('stage_fee','fine','library_fee','convocation','other') NOT NULL,
  description VARCHAR(255) NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  reference VARCHAR(64) NOT NULL UNIQUE,
  gateway ENUM('paystack') NOT NULL DEFAULT 'paystack',
  status ENUM('unpaid','success','failed') NOT NULL DEFAULT 'unpaid',
  raised_by INT NULL,                         -- staff who raised a fine/charge
  gateway_response JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME NULL,
  FOREIGN KEY (request_id) REFERENCES clearance_requests(request_id),
  FOREIGN KEY (stage_id) REFERENCES clearance_stages(stage_id),
  FOREIGN KEY (raised_by) REFERENCES staff(staff_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS certificates (
  certificate_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL UNIQUE,
  certificate_no VARCHAR(30) NOT NULL UNIQUE,
  verification_code VARCHAR(64) NOT NULL UNIQUE,
  issue_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  file_path VARCHAR(255) NOT NULL,
  -- Registry: the student brought this certificate and collected the signed degree certificate.
  degree_issued_at DATETIME NULL,
  degree_issued_by INT NULL,
  degree_serial_no VARCHAR(40) NULL,          -- serial number printed on the degree certificate (optional)
  degree_note VARCHAR(255) NULL,
  FOREIGN KEY (request_id) REFERENCES clearance_requests(request_id),
  FOREIGN KEY (degree_issued_by) REFERENCES staff(staff_id)
) ENGINE=InnoDB;

-- Forgot-password links. Only a SHA-256 hash of the token is stored; the token itself
-- is only in the emailed link. One use, short expiry.
CREATE TABLE IF NOT EXISTS password_resets (
  reset_id INT AUTO_INCREMENT PRIMARY KEY,
  user_type ENUM('student','staff') NOT NULL,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reset_user (user_type, user_id)
) ENGINE=InnoDB;

-- Clearance slip issued when an office approves a stage (school fees clearance receipt,
-- library clearance, ...). Attached automatically to later stages; verifiable by its code.
CREATE TABLE IF NOT EXISTS clearance_slips (
  slip_id INT AUTO_INCREMENT PRIMARY KEY,
  stage_id INT NOT NULL UNIQUE,
  slip_no VARCHAR(30) NOT NULL UNIQUE,
  verification_code VARCHAR(64) NOT NULL UNIQUE,
  issued_by INT NULL,                          -- approving officer; NULL for automatic stages
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  file_path VARCHAR(255) NOT NULL,
  FOREIGN KEY (stage_id) REFERENCES clearance_stages(stage_id),
  FOREIGN KEY (issued_by) REFERENCES staff(staff_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  notification_id INT AUTO_INCREMENT PRIMARY KEY,
  recipient_id INT NOT NULL,
  recipient_type ENUM('student','staff') NOT NULL,   -- polymorphic, no FK (enforced in code)
  message TEXT NOT NULL,
  link VARCHAR(255) NULL,                     -- page in the app the notification opens, e.g. /student/stage/12
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_recipient (recipient_type, recipient_id, is_read)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_type ENUM('student','staff','system') NOT NULL,
  actor_id INT NULL,
  action VARCHAR(60) NOT NULL,                -- e.g. 'stage.submit','stage.approve','payment.success'
  entity VARCHAR(40) NOT NULL,
  entity_id INT NULL,
  detail JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_entity (entity, entity_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS import_batches (
  batch_id INT AUTO_INCREMENT PRIMARY KEY,
  imported_by INT NOT NULL,
  filename VARCHAR(255) NULL,
  rows_total INT NOT NULL DEFAULT 0,
  rows_imported INT NOT NULL DEFAULT 0,
  rows_failed INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (imported_by) REFERENCES staff(staff_id)
) ENGINE=InnoDB;
