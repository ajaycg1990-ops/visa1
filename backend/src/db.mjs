import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import {
  createSignedToken,
  decryptField,
  decryptJson,
  encryptField,
  encryptJson,
  hashPassword,
  hashToken,
  isTokenSignatureValid,
  newId,
} from "./security.mjs";

/**
 * Data access layer.
 *
 * Everything that touches SQLite lives here, so moving to PostgreSQL later
 * means reimplementing this one module against the same exported functions.
 * Sensitive columns are encrypted on the way in and decrypted on the way out,
 * so callers always work with plain objects and never see ciphertext.
 */

let db;

const nowIso = () => new Date().toISOString();
const plusMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
/** SQLite has no boolean type: store 0/1. */
const flag = (value) => (value ? 1 : 0);
/** node:sqlite rejects `undefined`; normalise to null. */
const nn = (value) => (value === undefined ? null : value);

/* --------------------------------- schema --------------------------------- */

export function init() {
  if (db) return db;

  mkdirSync(path.dirname(config.databaseFile), { recursive: true });
  db = new DatabaseSync(config.databaseFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  if (!existsSync(config.schemaFile)) {
    throw new Error(`Schema file not found at ${config.schemaFile}`);
  }
  db.exec(readFileSync(config.schemaFile, "utf8"));
  migrate();

  if (config.seedDemo) seedDemoStudent();
  return db;
}

/**
 * Additive migrations for databases created by an earlier version.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so a column
 * added to schema.sql never reaches a database that already exists. Each step
 * checks before it acts, so running this repeatedly is safe.
 */
function migrate() {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  if (!columns("users").includes("role")) {
    // SQLite cannot add a CHECK constraint to an existing table, so the
    // constraint lives in schema.sql for new databases and the application
    // enforces the same values (see setUserRole).
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'");
    console.log("[db] migration: added users.role");
  }

  // Adaptive interview length (officer confidence, early approval, ranking).
  const add = (table, column, definition) => {
    if (!columns(table).includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[db] migration: added ${table}.${column}`);
    }
  };
  add("interviews", "confidence", "INTEGER");
  add("interviews", "ended_reason", "TEXT");
  add("interviews", "rank", "TEXT");
  add("interview_questions", "is_required", "INTEGER NOT NULL DEFAULT 0");
  add("interview_questions", "confidence_after", "INTEGER");
  // Personal document checklist.
  add("preferences", "checklist_done", "TEXT");
  // Interview-day mode.
  add("interviews", "exam_mode", "INTEGER NOT NULL DEFAULT 0");
  // Live question choice and the uploadable question bank.
  add("interviews", "required_topics", "TEXT");
  add("interview_questions", "topic", "TEXT");
  add("interview_questions", "origin", "TEXT");
}

export function close() {
  if (db) {
    db.close();
    db = undefined;
  }
}

const q = (sql) => init().prepare(sql);

/* -------------------------------- profile map ------------------------------ */

/**
 * API field name -> database column. Everything in this list is encrypted at
 * rest, and this list is also what the interview and coaching prompts see.
 */
export const PROFILE_FIELDS = {
  fullName: "full_name",
  homeCountry: "home_country",
  homeCity: "home_city",
  age: "age",
  highestDegree: "highest_degree",
  previousMajor: "previous_major",
  previousInstitution: "previous_institution",
  gpa: "gpa",
  graduationYear: "graduation_year",
  englishTest: "english_test",
  gapYears: "gap_years",
  usUniversity: "us_university",
  program: "program",
  degreeLevel: "degree_level",
  usCity: "us_city",
  startTerm: "start_term",
  programMonths: "program_months",
  tuitionUsd: "tuition_usd",
  totalCoaUsd: "total_coa_usd",
  sponsorName: "sponsor_name",
  sponsorRelation: "sponsor_relation",
  sponsorOccupation: "sponsor_occupation",
  annualIncomeUsd: "annual_income_usd",
  savingsUsd: "savings_usd",
  loanUsd: "loan_usd",
  scholarshipUsd: "scholarship_usd",
  whyUsa: "why_usa",
  whyProgram: "why_program",
  careerGoal: "career_goal",
  planAfter: "plan_after",
  tiesHome: "ties_home",
  previousApplications: "previous_applications",
  refusals: "refusals",
  refusalReason: "refusal_reason",
  relativesInUs: "relatives_in_us",
  travelHistory: "travel_history",
};

const PROFILE_KEYS = Object.keys(PROFILE_FIELDS);

/* ---------------------------------- users --------------------------------- */

export function createUser({ email, fullName, password = null, googleSub = null }) {
  const user = {
    id: newId("usr"),
    email: email.trim().toLowerCase(),
    full_name: fullName.trim(),
    password_hash: password ? hashPassword(password) : null,
    google_sub: googleSub,
    created_at: nowIso(),
  };

  q(
    `INSERT INTO users (id, email, full_name, password_hash, google_sub, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.full_name, nn(user.password_hash), nn(user.google_sub), user.created_at);

  q(`INSERT INTO preferences (user_id, theme, marketing_opt_in, product_emails, updated_at)
     VALUES (?, 'light', 0, 1, ?)`).run(user.id, nowIso());

  addNotification(user.id, {
    kind: "welcome",
    title: "Welcome to NIEC Visa AI",
    body: "Complete your applicant profile, then run your first mock interview. Every question you get is built from your own case.",
  });

  return findUserById(user.id);
}

export function findUserByEmail(email) {
  return q("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase()) ?? null;
}

export function findUserById(id) {
  return q("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function findUserByGoogleSub(sub) {
  return q("SELECT * FROM users WHERE google_sub = ?").get(sub) ?? null;
}

export function linkGoogleAccount(userId, sub) {
  q("UPDATE users SET google_sub = ? WHERE id = ?").run(sub, userId);
}

export function setUserPassword(userId, password) {
  q("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), userId);
}

export function touchLogin(userId) {
  q("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), userId);
}

/** What the client is allowed to see about an account. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role ?? "student",
    hasPassword: Boolean(user.password_hash),
    googleLinked: Boolean(user.google_sub),
    createdAt: user.created_at,
  };
}

export function isAdmin(user) {
  return (user?.role ?? "student") === "admin";
}

/** Promote or demote an account. Used by scripts/make-admin.mjs. */
export function setUserRole(email, role) {
  if (!["student", "admin"].includes(role)) throw new Error(`Unknown role: ${role}`);
  const user = findUserByEmail(email);
  if (!user) return null;
  q("UPDATE users SET role = ? WHERE id = ?").run(role, user.id);
  return findUserById(user.id);
}

export function listAdmins() {
  return q("SELECT email, full_name FROM users WHERE role = 'admin' ORDER BY email").all();
}

/* -------------------------------- sessions -------------------------------- */

export function createSession(userId, userAgent = "") {
  const token = createSignedToken();
  q(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    newId("ses"),
    userId,
    hashToken(token),
    nowIso(),
    new Date(Date.now() + config.sessionDays * 86_400_000).toISOString(),
    String(userAgent).slice(0, 200)
  );
  return token;
}

/** Resolve a bearer token to a user, rejecting forged or expired tokens. */
export function userForToken(token) {
  if (!isTokenSignatureValid(token)) return null;
  const row = q(
    `SELECT u.*, s.expires_at AS session_expires
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row) return null;
  if (new Date(row.session_expires).getTime() < Date.now()) {
    q("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  return row;
}

export function deleteSession(token) {
  if (typeof token !== "string") return;
  q("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function deleteAllSessions(userId) {
  q("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

/* ----------------------------- password resets ---------------------------- */

export function createPasswordReset(userId) {
  const token = createSignedToken();
  q(
    `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(newId("prt"), userId, hashToken(token), nowIso(), plusMinutes(config.resetTokenMinutes));
  return token;
}

/** Single-use: marks the token used and returns the owning user id. */
export function consumePasswordReset(token) {
  if (!isTokenSignatureValid(token)) return null;
  const row = q("SELECT * FROM password_resets WHERE token_hash = ?").get(hashToken(token));
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  q("UPDATE password_resets SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return row.user_id;
}

/* --------------------------------- profile -------------------------------- */

export function getProfile(userId) {
  const row = q("SELECT * FROM profiles WHERE user_id = ?").get(userId);
  if (!row) return null;
  const profile = { userId, updatedAt: row.updated_at };
  for (const [key, column] of Object.entries(PROFILE_FIELDS)) {
    profile[key] = decryptField(row[column]) ?? "";
  }
  return profile;
}

export function saveProfile(userId, input) {
  const columns = PROFILE_KEYS.map((key) => PROFILE_FIELDS[key]);
  const values = PROFILE_KEYS.map((key) => {
    const raw = input?.[key];
    return encryptField(typeof raw === "string" ? raw.trim() : "");
  });

  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns.map((column) => `${column} = excluded.${column}`).join(", ");

  q(
    `INSERT INTO profiles (user_id, ${columns.join(", ")}, updated_at)
     VALUES (?, ${placeholders}, ?)
     ON CONFLICT (user_id) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`
  ).run(userId, ...values.map(nn), nowIso());

  return getProfile(userId);
}

/** Share of profile fields filled in - drives the "complete your profile" nudge. */
export function profileCompleteness(profile) {
  if (!profile) return 0;
  const filled = PROFILE_KEYS.filter((key) => String(profile[key] ?? "").trim().length > 0).length;
  return Math.round((filled / PROFILE_KEYS.length) * 100);
}

/* ------------------------------- interviews ------------------------------- */

export function createInterview({ userId, mode, questionCount, profileSnapshot, engine, examMode = false, requiredTopics = null }) {
  const id = newId("int");
  q(
    `INSERT INTO interviews (id, user_id, mode, status, question_count, profile_snapshot, engine, exam_mode, required_topics, created_at)
     VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    mode,
    questionCount,
    nn(encryptJson(profileSnapshot)),
    engine,
    flag(examMode),
    requiredTopics ? JSON.stringify(requiredTopics) : null,
    nowIso()
  );
  return id;
}

export function addQuestion(
  interviewId,
  { position, category, question, isFollowUp = false, isRequired = false, topic = null, origin = null }
) {
  const id = newId("qst");
  q(
    `INSERT INTO interview_questions (id, interview_id, position, category, question, is_follow_up, is_required, topic, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, interviewId, position, category, encryptField(question), flag(isFollowUp), flag(isRequired), nn(topic), nn(origin));
  return id;
}

/** Record the officer's running confidence and, once decided, why the interview ends. */
export function updateInterviewProgress(interviewId, { confidence, endedReason = null }) {
  q("UPDATE interviews SET confidence = ?, ended_reason = COALESCE(?, ended_reason) WHERE id = ?").run(
    confidence,
    nn(endedReason),
    interviewId
  );
}

/** Remove one unanswered question (used to make room for a follow-up drill). */
export function dropQuestion(interviewId, position) {
  q("DELETE FROM interview_questions WHERE interview_id = ? AND position = ? AND answer IS NULL").run(
    interviewId,
    position
  );
}

/**
 * Make a gap at `position + 1` by pushing later questions down one slot.
 * Applied in descending order so the UNIQUE (interview_id, position) index is
 * never violated mid-update.
 */
export function shiftQuestionsAfter(interviewId, position) {
  const later = q(
    "SELECT position FROM interview_questions WHERE interview_id = ? AND position > ? ORDER BY position DESC"
  ).all(interviewId, position);
  const update = q(
    "UPDATE interview_questions SET position = ? WHERE interview_id = ? AND position = ?"
  );
  for (const row of later) update.run(row.position + 1, interviewId, row.position);
}

export function getInterview(interviewId) {
  const row = q("SELECT * FROM interviews WHERE id = ?").get(interviewId);
  return row ? mapInterview(row) : null;
}

function mapInterview(row) {
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    status: row.status,
    questionCount: row.question_count,
    profileSnapshot: decryptJson(row.profile_snapshot),
    engine: row.engine,
    modelUsed: row.model_used,
    overallScore: row.overall_score,
    verdict: row.verdict,
    summary: decryptField(row.summary),
    confidence: row.confidence ?? null,
    endedReason: row.ended_reason ?? null,
    rank: row.rank ?? null,
    examMode: Boolean(row.exam_mode),
    // null for interviews planned up front, before questions were chosen live.
    requiredTopics: row.required_topics ? JSON.parse(row.required_topics) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function getQuestions(interviewId) {
  return q("SELECT * FROM interview_questions WHERE interview_id = ? ORDER BY position ASC")
    .all(interviewId)
    .map((row) => ({
      id: row.id,
      position: row.position,
      category: row.category,
      question: decryptField(row.question),
      isFollowUp: Boolean(row.is_follow_up),
      isRequired: Boolean(row.is_required),
      topic: row.topic ?? null,
      origin: row.origin ?? null,
      confidenceAfter: row.confidence_after ?? null,
      answer: decryptField(row.answer),
      answerSeconds: row.answer_seconds,
      scores: {
        answer: row.answer_score,
        tone: row.tone_score,
        clarity: row.clarity_score,
      },
      feedback: decryptField(row.feedback),
      improvedAnswer: decryptField(row.improved_answer),
      whatToSay: decryptField(row.what_to_say),
      howToSayIt: decryptField(row.how_to_say_it),
      whyItWorks: decryptField(row.why_it_works),
      answeredAt: row.answered_at,
    }));
}

export function saveAnswer(interviewId, position, { answer, seconds, scores, feedback, coaching, confidenceAfter = null }) {
  q(
    `UPDATE interview_questions
        SET answer = ?, answer_seconds = ?, answer_score = ?, tone_score = ?, clarity_score = ?,
            feedback = ?, improved_answer = ?, what_to_say = ?, how_to_say_it = ?, why_it_works = ?,
            confidence_after = ?, answered_at = ?
      WHERE interview_id = ? AND position = ?`
  ).run(
    encryptField(answer),
    Math.max(0, Math.round(seconds || 0)),
    scores.answer,
    scores.tone,
    scores.clarity,
    nn(encryptField(feedback)),
    nn(encryptField(coaching?.improvedAnswer)),
    nn(encryptField(coaching?.whatToSay)),
    nn(encryptField(coaching?.howToSayIt)),
    nn(encryptField(coaching?.whyItWorks)),
    nn(confidenceAfter),
    nowIso(),
    interviewId,
    position
  );
}

export function setCategoryScores(interviewId, scores) {
  q("DELETE FROM interview_scores WHERE interview_id = ?").run(interviewId);
  const insert = q(
    "INSERT INTO interview_scores (id, interview_id, category, score) VALUES (?, ?, ?, ?)"
  );
  for (const { category, score } of scores) insert.run(newId("scr"), interviewId, category, score);
}

export function getCategoryScores(interviewId) {
  return q("SELECT category, score FROM interview_scores WHERE interview_id = ? ORDER BY score ASC")
    .all(interviewId)
    .map((row) => ({ category: row.category, score: row.score }));
}

export function setInsights(interviewId, insights) {
  q("DELETE FROM interview_insights WHERE interview_id = ?").run(interviewId);
  const insert = q(
    `INSERT INTO interview_insights (id, interview_id, kind, severity, label, detail, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of insights) {
    insert.run(
      newId("ins"),
      interviewId,
      item.kind,
      nn(item.severity ?? null),
      item.label,
      nn(encryptField(item.detail ?? "")),
      nn(item.position ?? null)
    );
  }
}

export function getInsights(interviewId) {
  return q("SELECT * FROM interview_insights WHERE interview_id = ?")
    .all(interviewId)
    .map((row) => ({
      kind: row.kind,
      severity: row.severity,
      label: row.label,
      detail: decryptField(row.detail),
      position: row.position,
    }));
}

export function completeInterview(
  interviewId,
  { overallScore, verdict, summary, modelUsed, engine, rank = null, endedReason = null, confidence = null }
) {
  q(
    `UPDATE interviews
        SET status = 'completed', overall_score = ?, verdict = ?, summary = ?,
            model_used = ?, engine = ?, rank = ?,
            ended_reason = COALESCE(ended_reason, ?), confidence = COALESCE(?, confidence),
            completed_at = ?
      WHERE id = ?`
  ).run(
    overallScore,
    verdict,
    nn(encryptField(summary)),
    nn(modelUsed),
    engine,
    nn(rank),
    nn(endedReason),
    nn(confidence),
    nowIso(),
    interviewId
  );
}

export function listInterviews(userId, limit = 50) {
  return q(
    `SELECT * FROM interviews WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  )
    .all(userId, limit)
    .map(mapInterview)
    .map((interview) => ({
      ...interview,
      // The list view never needs the frozen snapshot.
      profileSnapshot: undefined,
      answered: countAnswered(interview.id),
    }));
}

export function countAnswered(interviewId) {
  const row = q(
    "SELECT COUNT(*) AS n FROM interview_questions WHERE interview_id = ? AND answer IS NOT NULL"
  ).get(interviewId);
  return row?.n ?? 0;
}

/* ------------------------------- question bank ---------------------------- */

function mapBankQuestion(row) {
  return {
    id: row.id,
    question: row.question,
    category: row.category,
    topic: row.topic ?? null,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

export function listBankQuestions({ activeOnly = false } = {}) {
  return q(`SELECT * FROM bank_questions ${activeOnly ? "WHERE active = 1" : ""} ORDER BY created_at DESC, rowid DESC`)
    .all()
    .map(mapBankQuestion);
}

/**
 * Add parsed questions, skipping any already in the bank (same words, any
 * case or punctuation). Returns what was added and how many were duplicates.
 */
export function addBankQuestions(items, { createdBy = null, normalize }) {
  const exists = q("SELECT 1 FROM bank_questions WHERE norm = ?");
  const insert = q(
    `INSERT INTO bank_questions (id, question, norm, category, topic, active, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const added = [];
  let duplicates = 0;
  const seen = new Set();
  init().exec("BEGIN");
  try {
    for (const item of items) {
      const norm = normalize(item.question);
      if (!norm || seen.has(norm) || exists.get(norm)) {
        duplicates += 1;
        continue;
      }
      seen.add(norm);
      const id = newId("bq");
      insert.run(id, item.question, norm, item.category, nn(item.topic), nn(createdBy), nowIso());
      added.push({ id, ...item });
    }
    init().exec("COMMIT");
  } catch (error) {
    init().exec("ROLLBACK");
    throw error;
  }
  return { added, duplicates };
}

export function setBankQuestionActive(id, active) {
  const result = q("UPDATE bank_questions SET active = ? WHERE id = ?").run(flag(active), id);
  return result.changes > 0;
}

export function deleteBankQuestion(id) {
  return q("DELETE FROM bank_questions WHERE id = ?").run(id).changes > 0;
}

/* ------------------------------ answer retries ---------------------------- */

/** Attempts kept per question - the oldest drop off beyond this. */
const RETRIES_KEPT = 5;

export function addRetry(interviewId, position, { answer, scores, feedback, redFlags = [] }) {
  q(
    `INSERT INTO answer_retries (id, interview_id, position, answer, answer_score, tone_score, clarity_score,
                                 feedback, red_flags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId("rty"),
    interviewId,
    position,
    encryptField(answer),
    scores.answer,
    scores.tone,
    scores.clarity,
    nn(encryptField(feedback)),
    JSON.stringify(redFlags.map((f) => f.label)),
    nowIso()
  );
  q(
    `DELETE FROM answer_retries
      WHERE interview_id = ? AND position = ?
        AND id NOT IN (SELECT id FROM answer_retries WHERE interview_id = ? AND position = ?
                        ORDER BY created_at DESC, rowid DESC LIMIT ?)`
  ).run(interviewId, position, interviewId, position, RETRIES_KEPT);
}

/** Retries for one interview, oldest first, grouped by question position. */
export function getRetries(interviewId) {
  const byPosition = {};
  for (const row of q(
    "SELECT * FROM answer_retries WHERE interview_id = ? ORDER BY created_at ASC, rowid ASC"
  ).all(interviewId)) {
    (byPosition[row.position] ??= []).push({
      id: row.id,
      answer: decryptField(row.answer),
      scores: { answer: row.answer_score, tone: row.tone_score, clarity: row.clarity_score },
      feedback: decryptField(row.feedback),
      redFlags: JSON.parse(row.red_flags || "[]"),
      createdAt: row.created_at,
    });
  }
  return byPosition;
}

/** Everything needed to render a results page. */
export function getFullInterview(interviewId) {
  const interview = getInterview(interviewId);
  if (!interview) return null;
  const retries = getRetries(interviewId);
  return {
    ...interview,
    questions: getQuestions(interviewId).map((question) => ({ ...question, retries: retries[question.position] ?? [] })),
    categoryScores: getCategoryScores(interviewId),
    insights: getInsights(interviewId),
  };
}

/* ----------------------------- custom questions --------------------------- */

export function saveCustomQuestion(userId, entry) {
  const id = newId("cq");
  q(
    `INSERT INTO custom_questions
       (id, user_id, question, answer, what_to_say, how_to_say_it, why_it_works, warning, engine, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    encryptField(entry.question),
    encryptField(entry.answer),
    nn(encryptField(entry.whatToSay)),
    nn(encryptField(entry.howToSayIt)),
    nn(encryptField(entry.whyItWorks)),
    nn(encryptField(entry.warning)),
    entry.engine,
    nowIso()
  );
  return getCustomQuestion(id);
}

function mapCustom(row) {
  return {
    id: row.id,
    question: decryptField(row.question),
    answer: decryptField(row.answer),
    whatToSay: decryptField(row.what_to_say),
    howToSayIt: decryptField(row.how_to_say_it),
    whyItWorks: decryptField(row.why_it_works),
    warning: decryptField(row.warning),
    engine: row.engine,
    createdAt: row.created_at,
  };
}

export function getCustomQuestion(id) {
  const row = q("SELECT * FROM custom_questions WHERE id = ?").get(id);
  return row ? mapCustom(row) : null;
}

export function listCustomQuestions(userId, limit = 30) {
  return q("SELECT * FROM custom_questions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit)
    .map(mapCustom);
}

/* ------------------------------ notifications ----------------------------- */

export function addNotification(userId, { kind, title, body }) {
  const id = newId("ntf");
  q(
    `INSERT INTO notifications (id, user_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, userId, kind, title, body, nowIso());
  return id;
}

export function listNotifications(userId, limit = 30) {
  return q("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      read: Boolean(row.read_at),
      createdAt: row.created_at,
    }));
}

export function unreadCount(userId) {
  return q("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId).n;
}

export function markNotificationRead(userId, id) {
  q("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?").run(nowIso(), id, userId);
}

export function markAllNotificationsRead(userId) {
  q("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(nowIso(), userId);
}

/* ------------------------------- preferences ------------------------------ */

export function getPreferences(userId) {
  const row = q("SELECT * FROM preferences WHERE user_id = ?").get(userId);
  if (!row) {
    q(`INSERT INTO preferences (user_id, theme, marketing_opt_in, product_emails, updated_at)
       VALUES (?, 'light', 0, 1, ?)`).run(userId, nowIso());
    return { theme: "light", marketingOptIn: false, productEmails: true };
  }
  return {
    theme: row.theme,
    marketingOptIn: Boolean(row.marketing_opt_in),
    productEmails: Boolean(row.product_emails),
    updatedAt: row.updated_at,
  };
}

/** Ids of the ticked document-checklist items. */
export function getChecklistDone(userId) {
  getPreferences(userId); // makes sure the row exists
  const row = q("SELECT checklist_done FROM preferences WHERE user_id = ?").get(userId);
  try {
    return JSON.parse(row?.checklist_done || "[]");
  } catch {
    return [];
  }
}

export function saveChecklistDone(userId, ids) {
  getPreferences(userId);
  q("UPDATE preferences SET checklist_done = ?, updated_at = ? WHERE user_id = ?").run(JSON.stringify(ids), nowIso(), userId);
}

export function savePreferences(userId, { theme, marketingOptIn, productEmails }) {
  const current = getPreferences(userId);
  const next = {
    theme: ["light", "dark", "system"].includes(theme) ? theme : current.theme,
    marketingOptIn: typeof marketingOptIn === "boolean" ? marketingOptIn : current.marketingOptIn,
    productEmails: typeof productEmails === "boolean" ? productEmails : current.productEmails,
  };
  q(
    `UPDATE preferences SET theme = ?, marketing_opt_in = ?, product_emails = ?, updated_at = ? WHERE user_id = ?`
  ).run(next.theme, flag(next.marketingOptIn), flag(next.productEmails), nowIso(), userId);
  return getPreferences(userId);
}

/* ------------------------------ data requests ----------------------------- */

export function createDataRequest(userId, kind, note = "") {
  const id = newId("dr");
  q(
    `INSERT INTO data_requests (id, user_id, kind, status, note, created_at) VALUES (?, ?, ?, 'received', ?, ?)`
  ).run(id, userId, kind, String(note).slice(0, 500), nowIso());
  return q("SELECT * FROM data_requests WHERE id = ?").get(id);
}

export function listDataRequests(userId) {
  return q("SELECT * FROM data_requests WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
}

export function markDataRequestReady(id) {
  q("UPDATE data_requests SET status = 'ready' WHERE id = ?").run(id);
}

/**
 * Everything held about one account, decrypted, for a subject-access request.
 */
export function exportUserData(userId) {
  const user = findUserById(userId);
  const interviews = listInterviews(userId, 200).map((interview) => getFullInterview(interview.id));
  return {
    exportedAt: nowIso(),
    account: publicUser(user),
    profile: getProfile(userId),
    preferences: getPreferences(userId),
    documentChecklistTicked: getChecklistDone(userId),
    interviews,
    customQuestions: listCustomQuestions(userId, 500),
    notifications: listNotifications(userId, 500),
    dataRequests: listDataRequests(userId),
  };
}

/* --------------------------------- analytics ------------------------------- */

/** Aggregate performance across completed interviews. */
export function analytics(userId) {
  const completed = q(
    `SELECT * FROM interviews WHERE user_id = ? AND status = 'completed' ORDER BY completed_at ASC`
  ).all(userId);

  const series = completed.map((row) => ({
    id: row.id,
    mode: row.mode,
    score: row.overall_score ?? 0,
    verdict: row.verdict,
    date: row.completed_at,
  }));

  const categoryTotals = new Map();
  for (const row of completed) {
    for (const item of getCategoryScores(row.id)) {
      const bucket = categoryTotals.get(item.category) ?? [];
      bucket.push(item.score);
      categoryTotals.set(item.category, bucket);
    }
  }
  const categories = [...categoryTotals.entries()]
    .map(([category, scores]) => ({
      category,
      average: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      sessions: scores.length,
    }))
    .sort((a, b) => a.average - b.average);

  const dimensionRow = q(
    `SELECT AVG(q.answer_score) AS answer, AVG(q.tone_score) AS tone, AVG(q.clarity_score) AS clarity
       FROM interview_questions q
       JOIN interviews i ON i.id = q.interview_id
      WHERE i.user_id = ? AND i.status = 'completed' AND q.answer_score IS NOT NULL`
  ).get(userId);

  const scores = series.map((s) => s.score);
  const last = scores.at(-1) ?? null;
  const previous = scores.length > 1 ? scores.at(-2) : null;

  // Readiness leans on recent form, tempered by how much practice there is and
  // by unresolved high-severity red flags in the latest interview.
  const recent = scores.slice(-2);
  const recentAverage = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const practiceFactor = Math.min(scores.length / 3, 1);
  const openHighFlags = completed.length
    ? getInsights(completed.at(-1).id).filter((i) => i.kind === "red_flag" && i.severity === "high").length
    : 0;
  const readiness = scores.length
    ? Math.max(0, Math.min(100, Math.round(recentAverage * (0.7 + 0.3 * practiceFactor) - openHighFlags * 5)))
    : 0;

  return {
    completed: scores.length,
    readiness,
    lastScore: last,
    delta: last !== null && previous !== null ? last - previous : null,
    bestScore: scores.length ? Math.max(...scores) : null,
    averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    series,
    categories,
    strongest: categories.at(-1) ?? null,
    weakest: categories[0] ?? null,
    openHighFlags,
    dimensions: {
      answer: Math.round(dimensionRow?.answer ?? 0),
      tone: Math.round(dimensionRow?.tone ?? 0),
      clarity: Math.round(dimensionRow?.clarity ?? 0),
    },
    recommended: categories.filter((c) => c.average < 75).slice(0, 3).map((c) => c.category),
  };
}

/* --------------------------- admin reporting ------------------------------ */

/**
 * Aggregate reporting for NIEC staff.
 *
 * Everything below deliberately returns counts, dates and scores only. No
 * function here decrypts an answer, a profile field or coaching text: students
 * entered sponsor income, savings and refusal history on the understanding
 * that nobody reads it, and the privacy policy says so. Keep it that way -
 * if NIEC ever needs answer-level access, it should be a student opt-in, not
 * a quiet widening of this file.
 */
export function adminOverview() {
  const one = (sql, ...params) => q(sql).get(...params);

  const totals = {
    students: one("SELECT COUNT(*) n FROM users WHERE role = 'student'").n,
    admins: one("SELECT COUNT(*) n FROM users WHERE role = 'admin'").n,
    interviews: one("SELECT COUNT(*) n FROM interviews").n,
    completed: one("SELECT COUNT(*) n FROM interviews WHERE status = 'completed'").n,
    inProgress: one("SELECT COUNT(*) n FROM interviews WHERE status = 'in_progress'").n,
    coachQuestions: one("SELECT COUNT(*) n FROM custom_questions").n,
    openDataRequests: one("SELECT COUNT(*) n FROM data_requests WHERE status != 'completed'").n,
  };

  const scores = one(
    "SELECT AVG(overall_score) avg, MIN(overall_score) min, MAX(overall_score) max FROM interviews WHERE status = 'completed'"
  );

  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const recent = {
    signups: one("SELECT COUNT(*) n FROM users WHERE created_at >= ?", since).n,
    interviews: one("SELECT COUNT(*) n FROM interviews WHERE created_at >= ?", since).n,
  };

  // Daily activity for the last 14 days, for a simple trend line.
  const activity = q(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS interviews
       FROM interviews
      WHERE created_at >= ?
      GROUP BY day ORDER BY day ASC`
  ).all(new Date(Date.now() - 14 * 86_400_000).toISOString());

  const verdicts = q(
    "SELECT verdict, COUNT(*) n FROM interviews WHERE verdict IS NOT NULL GROUP BY verdict"
  ).all();

  const modes = q("SELECT mode, COUNT(*) n FROM interviews GROUP BY mode").all();

  // Which categories students struggle with most, across everyone. Useful for
  // deciding what NIEC should teach in person.
  const weakest = q(
    `SELECT category, ROUND(AVG(score)) AS average, COUNT(*) AS samples
       FROM interview_scores GROUP BY category ORDER BY average ASC`
  ).all();

  return {
    totals,
    scores: {
      average: scores.avg === null ? null : Math.round(scores.avg),
      lowest: scores.min,
      highest: scores.max,
    },
    recent,
    activity,
    verdicts,
    modes,
    categories: weakest,
  };
}

/**
 * One row per account for the admin list. Counts and dates only - no profile
 * fields, and nothing that reveals what a student wrote.
 */
export function adminStudents(limit = 200) {
  return q(
    `SELECT u.id, u.email, u.full_name, u.role, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM interviews i WHERE i.user_id = u.id) AS interviews,
            (SELECT COUNT(*) FROM interviews i WHERE i.user_id = u.id AND i.status = 'completed') AS completed,
            (SELECT ROUND(AVG(i.overall_score)) FROM interviews i WHERE i.user_id = u.id AND i.status = 'completed') AS average_score,
            (SELECT MAX(i.created_at) FROM interviews i WHERE i.user_id = u.id) AS last_interview_at,
            (SELECT COUNT(*) FROM custom_questions c WHERE c.user_id = u.id) AS coach_questions,
            EXISTS(SELECT 1 FROM profiles p WHERE p.user_id = u.id) AS has_profile
       FROM users u
      ORDER BY u.created_at DESC
      LIMIT ?`
  )
    .all(limit)
    .map((row) => ({
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role ?? "student",
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      interviews: row.interviews,
      completed: row.completed,
      averageScore: row.average_score,
      lastInterviewAt: row.last_interview_at,
      coachQuestions: row.coach_questions,
      hasProfile: Boolean(row.has_profile),
    }));
}

/** Every outstanding data access or deletion request, across all accounts. */
export function adminDataRequests() {
  return q(
    `SELECT r.id, r.kind, r.status, r.note, r.created_at, r.completed_at, u.email, u.full_name
       FROM data_requests r JOIN users u ON u.id = r.user_id
      ORDER BY (r.status = 'completed'), r.created_at DESC`
  )
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      email: row.email,
      fullName: row.full_name,
    }));
}

export function completeDataRequest(id) {
  q("UPDATE data_requests SET status = 'completed', completed_at = ? WHERE id = ?").run(nowIso(), id);
  return q("SELECT * FROM data_requests WHERE id = ?").get(id) ?? null;
}

/* ------------------------------- demo seed -------------------------------- */

/**
 * A demo student so the product can be explored immediately.
 * Runs only on a fresh database, and only when SEED_DEMO is on.
 */
function seedDemoStudent() {
  const email = "student@example.com";
  if (findUserByEmail(email)) return;

  const user = createUser({ email, fullName: "Demo Student", password: "Demo123!" });
  saveProfile(user.id, {
    fullName: "Demo Student",
    homeCountry: "Nepal",
    homeCity: "Kathmandu",
    age: "23",
    highestDegree: "Bachelor of Science",
    previousMajor: "Computer Science",
    previousInstitution: "Tribhuvan University",
    gpa: "3.4 / 4.0",
    graduationYear: "2025",
    englishTest: "IELTS 7.0",
    gapYears: "1 year",
    usUniversity: "Texas State University",
    program: "MS in Computer Science",
    degreeLevel: "Master's",
    usCity: "San Marcos, Texas",
    startTerm: "Fall 2026",
    programMonths: "24",
    tuitionUsd: "18500",
    totalCoaUsd: "34000",
    sponsorName: "Ram Bahadur Budhathoki",
    sponsorRelation: "Father",
    sponsorOccupation: "Owner, construction supply business",
    annualIncomeUsd: "22000",
    savingsUsd: "40000",
    loanUsd: "0",
    scholarshipUsd: "6000",
    whyUsa: "The applied data-systems specialisation I need is not offered by any programme at home.",
    whyProgram: "The MS has an analytics capstone and a data-systems track that match the work I want to do.",
    careerGoal: "Data engineer in Nepal's fintech sector",
    planAfter: "Return to Kathmandu and join a fintech firm building payment infrastructure.",
    tiesHome: "Family business, parents and property in Kathmandu.",
    previousApplications: "None",
    refusals: "No",
    refusalReason: "",
    relativesInUs: "Cousin, student visa, Texas",
    travelHistory: "India 2023, UAE 2024",
  });

  addNotification(user.id, {
    kind: "tip",
    title: "Start with the Neutral officer",
    body: "Neutral is closest to a real window. Once you score above 75 there, switch to Strict and see what survives.",
  });
}
