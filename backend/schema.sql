-- NIEC Visa AI - complete schema.
--
-- Runs on Node's built-in SQLite (node:sqlite, Node 22.5+). No migration tool
-- and no external database server: db.mjs applies this file on first start.
--
-- Columns marked "(encrypted)" hold AES-256-GCM ciphertext produced by
-- security.mjs. Sensitive applicant text never touches disk in plaintext.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

/* ------------------------------- accounts -------------------------------- */

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  -- NULL for accounts created purely through Google sign-in.
  password_hash   TEXT,
  -- Google "sub" claim, set when the account is linked to Google.
  google_sub      TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  last_login_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Signed session tokens. Only the SHA-256 hash of a token is stored, so a
-- database leak cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);

-- Password reset tokens, also stored hashed and single-use.
CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets (user_id);

/* -------------------------------- profile --------------------------------- */

-- The applicant's real case. Every free-text field is encrypted at rest.
CREATE TABLE IF NOT EXISTS profiles (
  user_id             TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  full_name           TEXT, -- (encrypted)
  home_country        TEXT, -- (encrypted)
  home_city           TEXT, -- (encrypted)
  age                 TEXT, -- (encrypted)
  highest_degree      TEXT, -- (encrypted)
  previous_major      TEXT, -- (encrypted)
  previous_institution TEXT, -- (encrypted)
  gpa                 TEXT, -- (encrypted)
  graduation_year     TEXT, -- (encrypted)
  english_test        TEXT, -- (encrypted)
  gap_years           TEXT, -- (encrypted)
  us_university       TEXT, -- (encrypted)
  program             TEXT, -- (encrypted)
  degree_level        TEXT, -- (encrypted)
  us_city             TEXT, -- (encrypted)
  start_term          TEXT, -- (encrypted)
  program_months      TEXT, -- (encrypted)
  tuition_usd         TEXT, -- (encrypted)
  total_coa_usd       TEXT, -- (encrypted)
  sponsor_name        TEXT, -- (encrypted)
  sponsor_relation    TEXT, -- (encrypted)
  sponsor_occupation  TEXT, -- (encrypted)
  annual_income_usd   TEXT, -- (encrypted)
  savings_usd         TEXT, -- (encrypted)
  loan_usd            TEXT, -- (encrypted)
  scholarship_usd     TEXT, -- (encrypted)
  why_usa             TEXT, -- (encrypted)
  why_program         TEXT, -- (encrypted)
  career_goal         TEXT, -- (encrypted)
  plan_after          TEXT, -- (encrypted)
  ties_home           TEXT, -- (encrypted)
  previous_applications TEXT, -- (encrypted)
  refusals            TEXT, -- (encrypted)
  refusal_reason      TEXT, -- (encrypted)
  relatives_in_us     TEXT, -- (encrypted)
  travel_history      TEXT, -- (encrypted)
  updated_at          TEXT NOT NULL
);

/* ------------------------------- interviews ------------------------------- */

CREATE TABLE IF NOT EXISTS interviews (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mode              TEXT NOT NULL CHECK (mode IN ('strict', 'neutral', 'casual')),
  status            TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  question_count    INTEGER NOT NULL,
  -- Frozen copy of the profile so an old session stays meaningful after edits.
  profile_snapshot  TEXT, -- (encrypted JSON)
  -- Which engine produced the questions and scoring, for reproducibility.
  engine            TEXT NOT NULL,
  model_used        TEXT,
  overall_score     INTEGER,
  verdict           TEXT,
  summary           TEXT, -- (encrypted)
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_interviews_user ON interviews (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interview_questions (
  id              TEXT PRIMARY KEY,
  interview_id    TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  category        TEXT NOT NULL,
  question        TEXT NOT NULL, -- (encrypted)
  is_follow_up    INTEGER NOT NULL DEFAULT 0,
  answer          TEXT,          -- (encrypted)
  answer_seconds  INTEGER,
  -- Per-answer scoring: the three dimensions shown after every answer.
  answer_score    INTEGER,
  tone_score      INTEGER,
  clarity_score   INTEGER,
  feedback        TEXT,          -- (encrypted)
  improved_answer TEXT,          -- (encrypted)
  what_to_say     TEXT,          -- (encrypted)
  how_to_say_it   TEXT,          -- (encrypted)
  why_it_works    TEXT,          -- (encrypted)
  answered_at     TEXT,
  UNIQUE (interview_id, position)
);

CREATE INDEX IF NOT EXISTS idx_questions_interview ON interview_questions (interview_id, position);

-- Category-level scoring (Academic, Financial, Intent to Return, ...).
CREATE TABLE IF NOT EXISTS interview_scores (
  id            TEXT PRIMARY KEY,
  interview_id  TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  score         INTEGER NOT NULL,
  UNIQUE (interview_id, category)
);

-- Strengths, weaknesses, recommendations and red flags for one interview.
CREATE TABLE IF NOT EXISTS interview_insights (
  id            TEXT PRIMARY KEY,
  interview_id  TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('strength', 'weakness', 'recommendation', 'red_flag')),
  severity      TEXT CHECK (severity IN ('high', 'medium', 'low')),
  label         TEXT NOT NULL,
  detail        TEXT, -- (encrypted)
  position      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_insights_interview ON interview_insights (interview_id);

/* ------------------------- custom question coaching ----------------------- */

CREATE TABLE IF NOT EXISTS custom_questions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question      TEXT NOT NULL, -- (encrypted)
  answer        TEXT NOT NULL, -- (encrypted)
  what_to_say   TEXT,          -- (encrypted)
  how_to_say_it TEXT,          -- (encrypted)
  why_it_works  TEXT,          -- (encrypted)
  warning       TEXT,          -- (encrypted)
  engine        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custom_user ON custom_questions (user_id, created_at DESC);

/* ------------------------- account and preferences ------------------------ */

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS preferences (
  user_id            TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  theme              TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'system')),
  marketing_opt_in   INTEGER NOT NULL DEFAULT 0,
  product_emails     INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL
);

-- Subject-access requests: the student asks for a copy of everything held.
CREATE TABLE IF NOT EXISTS data_requests (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('access', 'deletion')),
  status        TEXT NOT NULL CHECK (status IN ('received', 'ready', 'completed')),
  note          TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_data_requests_user ON data_requests (user_id, created_at DESC);
