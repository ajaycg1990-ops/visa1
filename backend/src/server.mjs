import http from "node:http";
import { config, assertProductionSecrets, usingDevSecrets } from "./config.mjs";
import * as db from "./db.mjs";
import * as ai from "./ai.mjs";
import { documentChecklist, cleanDone } from "./documents.mjs";
import * as interviewer from "./interviewer.mjs";
import { logger } from "./logger.mjs";
import { backupStatus, recentProblems, runChecks } from "./checks.mjs";
import { isEmail, passwordProblem, verifyPassword } from "./security.mjs";

/**
 * The API server.
 *
 * Plain node:http with a small router - no framework, no dependencies, so the
 * product runs straight from a clone. Every route is declared in ROUTES at the
 * bottom of the file, which doubles as the API index.
 */

const MAX_BODY_BYTES = 256 * 1024;
/** Question lists pasted from documents with sample answers run larger. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_FOLLOW_UPS = 3;

/* ------------------------------- HTTP helpers ------------------------------ */

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, message);
const unauthorized = (message = "Please sign in to continue.") => new HttpError(401, message);
const notFound = (message = "Not found.") => new HttpError(404, message);

function send(res, status, payload, extraHeaders = {}) {
  const body = payload === null ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), payment=()");
  // The API only ever returns JSON, so nothing may be loaded or framed from it.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badRequest("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

const str = (value, max = 5000) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

/**
 * Whether the person is on this computer. The web server forwards the real
 * visitor address (Cloudflare's verified one through a tunnel), so a public
 * visitor never looks local.
 */
function isLocalRequest(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(clientIp(req));
}

/* ------------------------------- rate limiting ----------------------------- */

/** Fixed-window counters per IP and bucket. In-memory by design: one node. */
const buckets = new Map();

function rateLimit(req, bucket) {
  const rule = config.rateLimits[bucket] ?? config.rateLimits.general;
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > rule.max) {
    const seconds = Math.ceil((entry.resetAt - now) / 1000);
    const error = new HttpError(429, `Too many requests. Try again in ${seconds}s.`);
    error.retryAfter = seconds;
    throw error;
  }
}

// Keep the counter map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) if (now > entry.resetAt) buckets.delete(key);
}, 60_000).unref();

/* ---------------------------------- auth ----------------------------------- */

function currentUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const user = db.userForToken(token);
  return user ? { user, token } : null;
}

function requireUser(req) {
  const session = currentUser(req);
  if (!session) throw unauthorized();
  return session.user;
}

/**
 * Admin-only guard.
 *
 * Returns 404 rather than 403 to a signed-in student, so the admin area does
 * not advertise its own existence to someone probing for it.
 */
function requireAdmin(req) {
  const user = requireUser(req);
  if (!db.isAdmin(user)) {
    logger.warn("non-admin tried to reach an admin route", { userId: user.id, path: req.url });
    throw notFound();
  }
  return user;
}

/* ------------------------------ email delivery ----------------------------- */

/**
 * Send a password reset email through Resend when configured.
 * Without a key, the link is returned to the caller in development so the
 * flow is testable end to end with no email provider.
 */
async function sendResetEmail(email, resetUrl) {
  if (!config.resendApiKey || !config.fromEmail) return { delivered: false, reason: "email_not_configured" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.fromEmail,
        to: email,
        subject: "Reset your NIEC Visa AI password",
        text: `Use this link to choose a new password. It expires in ${config.resetTokenMinutes} minutes.\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      }),
    });
    return { delivered: response.ok, reason: response.ok ? null : `resend_${response.status}` };
  } catch {
    return { delivered: false, reason: "resend_unreachable" };
  }
}

/* ------------------------------ Google sign-in ----------------------------- */

/**
 * Verify a Google ID token. Uses Google's tokeninfo endpoint so no JWT library
 * is needed; the audience check is what ties the token to this application.
 */
async function verifyGoogleCredential(credential) {
  if (!config.googleClientId) throw badRequest("Google sign-in is not configured on this server.");
  let payload;
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );
    if (!response.ok) throw new Error("bad token");
    payload = await response.json();
  } catch {
    throw badRequest("Could not verify that Google sign-in. Please try again.");
  }
  if (payload.aud !== config.googleClientId) throw badRequest("That Google sign-in was issued for another application.");
  if (payload.email_verified !== "true" && payload.email_verified !== true) {
    throw badRequest("Your Google email is not verified.");
  }
  return { sub: payload.sub, email: String(payload.email).toLowerCase(), name: payload.name || payload.email };
}

/* -------------------------------- interviews -------------------------------- */

/** The next unanswered question in an interview, or null when it is finished. */
function pendingQuestion(interviewId) {
  return db.getQuestions(interviewId).find((q) => !q.answer) ?? null;
}

function publicQuestion(question, total, answered, { examMode = false } = {}) {
  // A real officer does not label their questions, so interview-day mode
  // sends only the question itself.
  if (examMode) return { position: question.position, question: question.question, number: answered + 1 };
  return {
    position: question.position,
    category: question.category,
    question: question.question,
    isFollowUp: question.isFollowUp,
    number: answered + 1,
    total,
  };
}

/**
 * Interview-day mode draws the officer at random, weighted towards the neutral
 * one most students meet. The student finds out who it was in the report.
 */
function randomOfficer() {
  const roll = Math.random();
  return roll < 0.5 ? "neutral" : roll < 0.8 ? "strict" : "casual";
}

/**
 * Insert a follow-up directly after `position`.
 *
 * To stop the plan growing, the last optional question not yet asked is
 * dropped to make room. Required questions (the pillars and the student's own
 * risk topics) are never dropped. Ordinary drills are capped at MAX_FOLLOW_UPS;
 * a red-flag challenge passes `force`, because an officer who hears a
 * contradiction always asks about it.
 */
function insertFollowUp(interviewId, position, drill, { force = false } = {}) {
  const questions = db.getQuestions(interviewId);
  const followUpCount = questions.filter((q) => q.isFollowUp).length;
  if (!force && followUpCount >= MAX_FOLLOW_UPS) return false;

  const lastOptional = [...questions]
    .reverse()
    .find((q) => !q.answer && !q.isFollowUp && !q.isRequired && q.position > position);
  if (lastOptional) db.dropQuestion(interviewId, lastOptional.position);

  db.shiftQuestionsAfter(interviewId, position);
  db.addQuestion(interviewId, {
    position: position + 1,
    category: drill.category,
    question: drill.question,
    isFollowUp: true,
  });
  return true;
}

/** Red flags for an answered question: cached from answering, or recomputed. */
function flagsFor(interview, question) {
  return pendingFlags.get(`${interview.id}:${question.position}`) ?? recomputeFlags(question, interview);
}

/** Parse an upload request's text, with the checks both preview and add need. */
function parseUpload(body) {
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) throw badRequest("Paste some questions or choose a file first.");
  const parsed = interviewer.parseQuestionUpload(text);
  if (parsed.items.length > 1000) throw badRequest("That is more than 1,000 questions - please upload it in parts.");
  if (!parsed.items.length) {
    throw badRequest(
      parsed.skipped.length
        ? `No questions found - all ${parsed.skipped.length} line(s) were headings, answers or too short. Put one question per line.`
        : "No questions found. Put one question per line."
    );
  }
  return parsed;
}

/** What the admin question-bank screen shows. */
function bankPayload() {
  const uploaded = db.listBankQuestions();
  return {
    uploaded,
    builtIn: ai.BANK.map((entry) => ({
      topic: entry.id,
      category: entry.category,
      question: entry.text,
      // Only asked when the student's file has it: a loan, a refusal, a gap.
      conditional: Boolean(entry.requires),
    })),
    stats: {
      builtIn: ai.BANK.length,
      uploaded: uploaded.length,
      active: uploaded.filter((q) => q.active).length,
      byCategory: ai.CATEGORIES.map((category) => ({
        category,
        count: uploaded.filter((q) => q.active && q.category === category).length,
      })),
    },
  };
}

/** The active question bank for one student: built-in topics plus staff uploads. */
function questionPool(profile) {
  return interviewer.buildPool(db.listBankQuestions({ activeOnly: true }), profile);
}

/**
 * What the student sees after an answer. Interview day sends nothing but the
 * next question - no scores, feedback or hint of a challenge - because at a
 * real window it all waits until the end.
 */
function answerResponse({ interview, review, answered, done, endedReason, challenged, next }) {
  const max = ai.ADAPTIVE.maxQuestions;
  if (interview.examMode) {
    return {
      answered,
      done,
      endedReason,
      question: next ? publicQuestion(next, max, answered, { examMode: true }) : null,
    };
  }
  return {
    scores: review.scores,
    feedback: review.feedback,
    spoken: review.spoken,
    answered,
    total: max,
    done,
    endedReason,
    challenged,
    question: next ? publicQuestion(next, max, answered) : null,
  };
}

/**
 * One answer in a live interview: nothing after it exists yet. The officer
 *   1. scores it and updates their confidence,
 *   2. decides whether they have heard enough,
 *   3. if not, chooses the next question from what was just said - a
 *      challenge to a red flag, a follow-up on something in the answer, or the
 *      next question from the bank.
 * The coaching text (which may come from the AI provider) and the choice of
 * the next question run side by side, so the student waits for one, not both.
 */
async function submitAnswerLive({ interview, pending, profile, answer, seconds, inputMode }) {
  const mode = interview.mode;
  const base = { question: pending.question, category: pending.category, topic: pending.topic, answer, profile };
  const reviewing = ai.reviewAnswer({ ...base, seconds, mode, position: pending.position, inputMode });

  // Scoring and red flags are deterministic - the same numbers reviewAnswer
  // returns - so the decision does not have to wait for the provider.
  const scores = ai.scoreAnswer({ ...base, seconds, mode, inputMode });
  const redFlags = ai.redFlagsFor({ ...base, scores, position: pending.position });
  const confidence = ai.nextConfidence(interview.confidence ?? ai.ADAPTIVE.startConfidence, { scores, redFlags, mode });
  pendingFlags.set(`${interview.id}:${pending.position}`, redFlags);

  const rows = db
    .getQuestions(interview.id)
    .map((q) => (q.position === pending.position ? { ...q, answer, scores, confidenceAfter: confidence } : q));
  const answeredRows = rows.filter((q) => q.answer);
  const challenge = ai.challengeFor(redFlags, rows.map((q) => q.question));

  const decision = ai.officerDecision({
    mode,
    answered: answeredRows.length,
    confidence,
    requiredRemaining: interviewer.requiredRemaining(rows, interview.requiredTopics),
    weakRequired: ai.weakEssentials(answeredRows, mode),
    highFlagsSoFar: answeredRows.flatMap((q) => flagsFor(interview, q)).filter((f) => f.severity === "high").length,
    saidReturn: ai.statedReturn(answeredRows.map((q) => q.answer)),
    fileShortfall: ai.hasFileShortfall(profile),
    challengeQueued: Boolean(challenge),
    // The bank always has more; running dry is handled below.
    questionsLeft: 1,
  });

  const choosing =
    decision.done || challenge
      ? null
      : interviewer.nextQuestion({
          rows,
          profile,
          mode,
          requiredTopics: interview.requiredTopics,
          pool: questionPool(profile),
        });
  const [review, chosen] = await Promise.all([reviewing, choosing]);

  db.saveAnswer(interview.id, pending.position, {
    answer,
    seconds,
    scores: review.scores,
    feedback: review.feedback,
    coaching: review.coaching,
    confidenceAfter: confidence,
  });

  let endedReason = decision.done ? decision.reason : null;
  let next = null;
  if (!decision.done) {
    const upcoming = challenge
      ? { ...challenge, topic: pending.topic ?? null, origin: "challenge", isFollowUp: true, required: false }
      : chosen;
    if (upcoming) {
      db.addQuestion(interview.id, {
        position: Math.max(...rows.map((q) => q.position)) + 1,
        category: upcoming.category,
        question: upcoming.question,
        isFollowUp: Boolean(upcoming.isFollowUp),
        isRequired: Boolean(upcoming.required),
        topic: upcoming.topic ?? null,
        origin: upcoming.origin ?? null,
      });
      next = pendingQuestion(interview.id);
    } else {
      endedReason = "no_more_questions";
    }
  }

  db.updateInterviewProgress(interview.id, { confidence, endedReason });
  return answerResponse({
    interview,
    review,
    answered: answeredRows.length,
    done: Boolean(endedReason),
    endedReason,
    challenged: Boolean(challenge) && !decision.done,
    next,
  });
}

/** The checklist for a student's current file, with their ticks. */
function checklistFor(userId) {
  const { groups, items } = documentChecklist(db.getProfile(userId));
  const done = cleanDone(db.getChecklistDone(userId), items);
  const essential = items.filter((i) => i.essential);
  return {
    groups,
    items,
    done,
    progress: {
      done: done.length,
      total: items.length,
      essentialDone: essential.filter((i) => done.includes(i.id)).length,
      essentialTotal: essential.length,
    },
  };
}

/** A student's completed interviews with their answers, oldest first. */
function completedInterviews(userId) {
  return db
    .listInterviews(userId, 50)
    .filter((interview) => interview.status === "completed")
    .reverse()
    .map((interview) => ({
      id: interview.id,
      createdAt: interview.createdAt,
      questions: db.getQuestions(interview.id).filter((q) => q.answer),
    }));
}

/**
 * Attach the "your story" alerts to a report: facts said in THIS interview
 * that leave the file, or differ from what was said in an earlier one. Judged
 * against the file as it was when this interview ran.
 */
function withStory(results) {
  if (!results) return results;
  const upToThis = completedInterviews(results.userId).filter((i) => i.createdAt <= results.createdAt);
  const story = ai.storyConsistency(upToThis, results.profileSnapshot);
  return { ...results, storyIssues: story.issues.filter((issue) => issue.interviewId === results.id) };
}

/* --------------------------------- handlers -------------------------------- */

const handlers = {
  /* ---- health and public config ---- */

  async health() {
    return {
      status: "ok",
      service: "niec-visa-ai",
      engine: ai.engineName(),
      time: new Date().toISOString(),
    };
  },

  async publicConfig() {
    return {
      googleClientId: config.googleClientId || null,
      googleEnabled: Boolean(config.googleClientId),
      // Only offered when the seeded demo student actually exists, so a
      // production instance with SEED_DEMO=0 never shows a dead button.
      demoAvailable: Boolean(config.seedDemo && db.findUserByEmail("student@example.com")),
      aiProvider: config.ai.enabled ? config.ai.model : null,
      engine: ai.engineName(),
      modes: Object.values(ai.MODES).map((m) => ({ id: m.id, name: m.name, blurb: m.blurb, greeting: m.greeting })),
      questionCount: ai.DEFAULT_QUESTION_COUNT,
      categories: ai.CATEGORIES,
      // For the report's confidence graph and the "up to N questions" copy.
      adaptive: {
        minQuestions: ai.ADAPTIVE.minQuestions,
        maxQuestions: ai.ADAPTIVE.maxQuestions,
        thresholds: ai.ADAPTIVE.thresholds,
        startConfidence: ai.ADAPTIVE.startConfidence,
      },
    };
  },

  /* ---- auth ---- */

  async register(req, _params, body) {
    rateLimit(req, "auth");
    const fullName = str(body.fullName, 120);
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";

    if (fullName.length < 2) throw badRequest("Please enter your full name.");
    if (!isEmail(email)) throw badRequest("Please enter a valid email address.");
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    if (db.findUserByEmail(email)) throw new HttpError(409, "An account with that email already exists.");

    const user = db.createUser({ email, fullName, password });
    if (body.marketingOptIn === true) db.savePreferences(user.id, { marketingOptIn: true });
    db.touchLogin(user.id);

    return {
      token: db.createSession(user.id, req.headers["user-agent"]),
      user: db.publicUser(user),
    };
  },

  async login(req, _params, body) {
    rateLimit(req, "auth");
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const user = db.findUserByEmail(email);

    // One message for both cases, so the endpoint cannot enumerate accounts.
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw unauthorized("Email or password is incorrect.");
    }
    db.touchLogin(user.id);
    return { token: db.createSession(user.id, req.headers["user-agent"]), user: db.publicUser(user) };
  },

  /**
   * Staff sign-in, for the separate admin portal.
   *
   * Same credentials as the student site, but this endpoint refuses anyone
   * who is not an admin, and says nothing about why: a wrong password, a
   * non-existent account and a valid student account all produce the same
   * message, so the portal cannot be used to discover which addresses are
   * staff. Shares the strict auth rate-limit bucket.
   */
  async staffLogin(req, _params, body) {
    rateLimit(req, "auth");
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const user = db.findUserByEmail(email);

    const refused = unauthorized("Those details do not give access to the staff portal.");
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) throw refused;

    if (!db.isAdmin(user)) {
      logger.warn("student account attempted a staff sign-in", { userId: user.id, ip: clientIp(req) });
      throw refused;
    }

    logger.info("staff signed in", { userId: user.id, ip: clientIp(req) });
    db.touchLogin(user.id);
    return { token: db.createSession(user.id, req.headers["user-agent"]), user: db.publicUser(user) };
  },

  async googleAuth(req, _params, body) {
    rateLimit(req, "auth");
    const credential = str(body.credential, 4000);
    if (!credential) throw badRequest("Missing Google credential.");

    const profile = await verifyGoogleCredential(credential);
    let user = db.findUserByGoogleSub(profile.sub) ?? db.findUserByEmail(profile.email);

    if (!user) {
      user = db.createUser({ email: profile.email, fullName: profile.name, googleSub: profile.sub });
    } else if (!user.google_sub) {
      db.linkGoogleAccount(user.id, profile.sub);
      user = db.findUserById(user.id);
    }

    db.touchLogin(user.id);
    return { token: db.createSession(user.id, req.headers["user-agent"]), user: db.publicUser(user) };
  },

  async logout(req) {
    const session = currentUser(req);
    if (session) db.deleteSession(session.token);
    return { signedOut: true };
  },

  async forgotPassword(req, _params, body) {
    rateLimit(req, "auth");
    const email = str(body.email, 200).toLowerCase();
    if (!isEmail(email)) throw badRequest("Please enter a valid email address.");

    const user = db.findUserByEmail(email);
    // Always the same response shape, whether or not the account exists.
    const response = { sent: true, message: "If that email has an account, a reset link is on its way." };
    if (!user) return response;

    const token = db.createPasswordReset(user.id);
    const resetUrl = `${config.publicAppUrl}/#/reset?token=${encodeURIComponent(token)}`;
    const delivery = await sendResetEmail(user.email, resetUrl);

    db.addNotification(user.id, {
      kind: "security",
      title: "Password reset requested",
      body: "A password reset link was generated for your account. If that was not you, sign in and change your password.",
    });

    // In development, hand the link back so the flow works with no mail
    // provider - but only to someone at this computer. Through a public link
    // (a tunnel) that would let anyone reset anyone's password.
    if (!delivery.delivered && !config.isProduction && isLocalRequest(req)) {
      return { ...response, devResetUrl: resetUrl, delivery: delivery.reason };
    }
    return response;
  },

  async resetPassword(req, _params, body) {
    rateLimit(req, "auth");
    const token = str(body.token, 500);
    const password = typeof body.password === "string" ? body.password : "";
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);

    const userId = db.consumePasswordReset(token);
    if (!userId) throw badRequest("That reset link is invalid or has expired. Request a new one.");

    db.setUserPassword(userId, password);
    // Any stolen session is useless after a reset.
    db.deleteAllSessions(userId);
    db.addNotification(userId, {
      kind: "security",
      title: "Password changed",
      body: "Your password was changed and all other sessions were signed out.",
    });

    const user = db.findUserById(userId);
    return { token: db.createSession(userId, req.headers["user-agent"]), user: db.publicUser(user) };
  },

  /* ---- account ---- */

  async me(req) {
    const user = requireUser(req);
    const profile = db.getProfile(user.id);
    return {
      user: db.publicUser(user),
      profile,
      completeness: db.profileCompleteness(profile),
      preferences: db.getPreferences(user.id),
      unreadNotifications: db.unreadCount(user.id),
      engine: ai.engineName(),
    };
  },

  async getProfile(req) {
    const user = requireUser(req);
    const profile = db.getProfile(user.id);
    return { profile, completeness: db.profileCompleteness(profile) };
  },

  async saveProfile(req, _params, body) {
    const user = requireUser(req);
    if (!body || typeof body !== "object") throw badRequest("Nothing to save.");
    const profile = db.saveProfile(user.id, body);
    return { profile, completeness: db.profileCompleteness(profile) };
  },

  async getPreferences(req) {
    const user = requireUser(req);
    return { preferences: db.getPreferences(user.id) };
  },

  async savePreferences(req, _params, body) {
    const user = requireUser(req);
    return { preferences: db.savePreferences(user.id, body ?? {}) };
  },

  async notifications(req) {
    const user = requireUser(req);
    return { notifications: db.listNotifications(user.id), unread: db.unreadCount(user.id) };
  },

  async readNotifications(req, _params, body) {
    const user = requireUser(req);
    if (body?.all === true) db.markAllNotificationsRead(user.id);
    else if (str(body?.id, 60)) db.markNotificationRead(user.id, str(body.id, 60));
    else throw badRequest("Pass an id, or all: true.");
    return { unread: db.unreadCount(user.id) };
  },

  async createDataRequest(req, _params, body) {
    const user = requireUser(req);
    const kind = body?.kind === "deletion" ? "deletion" : "access";
    const request = db.createDataRequest(user.id, kind, str(body?.note, 500));
    db.markDataRequestReady(request.id);
    db.addNotification(user.id, {
      kind: "privacy",
      title: kind === "access" ? "Data access request received" : "Data deletion request received",
      body:
        kind === "access"
          ? "Your copy is ready to download from Settings. It contains everything held about your account."
          : "Your deletion request was logged. NIEC will confirm before anything is removed.",
    });
    return { request: db.listDataRequests(user.id)[0] };
  },

  async listDataRequests(req) {
    const user = requireUser(req);
    return { requests: db.listDataRequests(user.id) };
  },

  async exportData(req) {
    const user = requireUser(req);
    return db.exportUserData(user.id);
  },

  /* ---- interviews ---- */

  async startInterview(req, _params, body) {
    const user = requireUser(req);
    rateLimit(req, "ai");

    const examMode = body?.examMode === true;
    const mode = examMode ? randomOfficer() : ["strict", "neutral", "casual"].includes(body?.mode) ? body.mode : "neutral";

    // A missing or half-filled profile is allowed on purpose. Making students
    // complete 36 fields before their first question is what stops them ever
    // taking one; the interview simply gets more personal as the file fills up.
    const profile = db.getProfile(user.id);
    const completeness = db.profileCompleteness(profile);

    // Nothing is planned up front: only the opening question exists. Every
    // later question is chosen after the answer before it (see submitAnswer).
    const engine = ai.engineName();
    const model = engine === "provider" ? config.ai.model : null;
    const pool = interviewer.buildPool(db.listBankQuestions({ activeOnly: true }), profile);
    const opening = interviewer.firstQuestion(pool);
    const interviewId = db.createInterview({
      userId: user.id,
      mode,
      questionCount: ai.ADAPTIVE.maxQuestions,
      profileSnapshot: profile,
      engine,
      examMode,
      requiredTopics: interviewer.requiredTopicsFor(profile),
    });
    db.addQuestion(interviewId, {
      position: 0,
      category: opening.category,
      question: opening.question,
      isRequired: true,
      topic: opening.topic,
      origin: opening.origin,
    });
    db.updateInterviewProgress(interviewId, { confidence: ai.ADAPTIVE.startConfidence });

    // The length is no longer fixed: `total` is the most the officer will ask.
    const max = ai.ADAPTIVE.maxQuestions;
    const first = pendingQuestion(interviewId);
    return {
      id: interviewId,
      // Interview-day mode keeps the officer's identity for the report.
      mode: examMode ? null : mode,
      examMode,
      engine,
      model,
      greeting: ai.MODES[mode].greeting,
      total: examMode ? null : max,
      minimum: examMode ? null : ai.ADAPTIVE.minQuestions,
      question: publicQuestion(first, max, 0, { examMode }),
      // Lets the interview screen tell the student their questions are generic
      // because the file is thin, rather than leaving them to wonder.
      profileCompleteness: completeness,
    };
  },

  async listInterviews(req) {
    const user = requireUser(req);
    return { interviews: db.listInterviews(user.id) };
  },

  async getInterviewState(req, params) {
    const user = requireUser(req);
    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");

    const questions = db.getQuestions(interview.id);
    const answered = questions.filter((q) => q.answer).length;
    // Once the officer has decided, there is no next question even if the plan
    // still holds unasked ones - the page then goes straight to the report.
    const pending = interview.endedReason ? null : (questions.find((q) => !q.answer) ?? null);
    const max = ai.ADAPTIVE.maxQuestions;

    const examMode = interview.examMode;
    return {
      id: interview.id,
      mode: examMode ? null : interview.mode,
      examMode,
      status: interview.status,
      total: examMode ? null : max,
      answered,
      endedReason: interview.endedReason,
      greeting: ai.MODES[interview.mode]?.greeting ?? "",
      question: pending ? publicQuestion(pending, max, answered, { examMode }) : null,
      // No transcript on interview day - at the window you cannot scroll back.
      transcript: examMode
        ? []
        : questions
        .filter((q) => q.answer)
        .map((q) => ({
          position: q.position,
          category: q.category,
          question: q.question,
          answer: q.answer,
          scores: q.scores,
          feedback: q.feedback,
        })),
    };
  },

  /**
   * Submit one answer.
   *
   * The officer then does three things, in order:
   *   1. updates their confidence in the applicant,
   *   2. reacts - an immediate challenge if the answer raised a red flag, or a
   *      drill if it was thin,
   *   3. decides whether they have heard enough.
   *
   * Returns the per-answer scores, then either the next question or done: true
   * with the reason (approved early, or the maximum reached).
   */
  async submitAnswer(req, params, body) {
    const user = requireUser(req);
    rateLimit(req, "ai");

    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");
    if (interview.status !== "in_progress") throw new HttpError(409, "This interview is already finished.");
    if (interview.endedReason) throw new HttpError(409, "The officer has finished with you. Open your report.");

    const answer = str(body?.answer, 4000);
    if (!answer) throw badRequest("Say or type something before moving on.");
    const seconds = Math.max(0, Math.round(Number(body?.seconds) || 0));
    // Voice or typed - pace is only judged for spoken answers.
    const inputMode = body?.inputMode === "voice" ? "voice" : "typed";

    const pending = pendingQuestion(interview.id);
    if (!pending) throw new HttpError(409, "There is no open question to answer.");

    const profile = interview.profileSnapshot ?? db.getProfile(user.id);

    // Interviews started since questions are chosen live. Older ones were
    // planned up front and finish the way they started (below).
    if (Array.isArray(interview.requiredTopics)) {
      return submitAnswerLive({ interview, pending, profile, answer, seconds, inputMode });
    }

    const review = await ai.reviewAnswer({
      question: pending.question,
      category: pending.category,
      topic: pending.topic,
      answer,
      seconds,
      profile,
      mode: interview.mode,
      position: pending.position,
      inputMode,
    });

    // 1. Confidence.
    const confidence = ai.nextConfidence(interview.confidence ?? ai.ADAPTIVE.startConfidence, {
      scores: review.scores,
      redFlags: review.redFlags,
      mode: interview.mode,
    });

    db.saveAnswer(interview.id, pending.position, {
      answer,
      seconds,
      scores: review.scores,
      feedback: review.feedback,
      coaching: review.coaching,
      confidenceAfter: confidence,
    });
    // Red flags are stashed on the question row's insights at finish time.
    pendingFlags.set(`${interview.id}:${pending.position}`, review.redFlags);

    // 2. Reaction. A red flag gets challenged at once, whatever else is
    // planned. Otherwise, a thin answer to a planned question may be drilled -
    // never a follow-up to a follow-up, which drifts off topic.
    const asked = db.getQuestions(interview.id).map((q) => q.question);
    const challenge = ai.challengeFor(review.redFlags, asked);
    // A weak answer to an essential question is always followed up - that is
    // both what an officer would do and the student's chance to recover.
    const weakEssential = pending.isRequired && ai.trueQuality(review.scores, interview.mode) < ai.ADAPTIVE.requiredFloor;
    let challenged = false;
    if (challenge) {
      challenged = insertFollowUp(interview.id, pending.position, challenge, { force: true });
    } else if (!pending.isFollowUp) {
      const drill = ai.followUpFor({
        mode: interview.mode,
        question: pending.question,
        category: pending.category,
        answer,
        alreadyAsked: asked,
        force: weakEssential,
      });
      if (drill) insertFollowUp(interview.id, pending.position, drill, { force: weakEssential });
    }

    // 3. Decision.
    const questions = db.getQuestions(interview.id);
    const answeredRows = questions.filter((q) => q.answer);
    const decision = ai.officerDecision({
      mode: interview.mode,
      answered: answeredRows.length,
      confidence,
      requiredRemaining: questions.filter((q) => q.isRequired && !q.answer).length,
      weakRequired: ai.weakEssentials(answeredRows, interview.mode),
      highFlagsSoFar: answeredRows.flatMap((q) => flagsFor(interview, q)).filter((f) => f.severity === "high").length,
      saidReturn: ai.statedReturn(answeredRows.map((q) => q.answer)),
      fileShortfall: ai.hasFileShortfall(profile),
      challengeQueued: challenged,
      questionsLeft: questions.filter((q) => !q.answer).length,
    });

    db.updateInterviewProgress(interview.id, {
      confidence,
      endedReason: decision.done ? decision.reason : null,
    });

    const next = decision.done ? null : (questions.find((q) => !q.answer) ?? null);
    return answerResponse({
      interview,
      review,
      answered: answeredRows.length,
      done: decision.done,
      endedReason: decision.reason,
      challenged,
      next,
    });
  },

  /** Close the interview and produce the full report. */
  async finishInterview(req, params) {
    const user = requireUser(req);
    rateLimit(req, "ai");

    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");
    if (interview.status === "completed") return { results: withStory(db.getFullInterview(interview.id)) };

    const questions = db.getQuestions(interview.id);
    const answered = questions.filter((q) => q.answer);
    if (!answered.length) throw new HttpError(409, "Answer at least one question before finishing.");

    // Re-attach the red flags raised while answering.
    const enriched = answered.map((q) => ({ ...q, redFlags: flagsFor(interview, q) }));

    // What the officer actually did. If the student pressed "End" themselves,
    // there is no officer decision yet, so it is recorded as student_ended.
    const outcome = {
      endedReason: interview.endedReason ?? "student_ended",
      confidence: interview.confidence ?? ai.ADAPTIVE.startConfidence,
      requiredRemaining: Array.isArray(interview.requiredTopics)
        ? interviewer.requiredRemaining(questions, interview.requiredTopics)
        : questions.filter((q) => q.isRequired && !q.answer).length,
      weakRequired: ai.weakEssentials(answered, interview.mode),
    };

    const report = ai.buildReport({
      questions: enriched,
      mode: interview.mode,
      profile: interview.profileSnapshot,
      outcome,
    });

    db.setCategoryScores(
      interview.id,
      report.categoryScores.map((c) => ({ category: c.category, score: c.score }))
    );
    db.setInsights(interview.id, report.insights);
    db.completeInterview(interview.id, {
      overallScore: report.overallScore,
      verdict: report.verdict,
      summary: report.summary,
      modelUsed: config.ai.enabled ? config.ai.model : null,
      engine: interview.engine,
      rank: report.rank,
      endedReason: outcome.endedReason,
      confidence: outcome.confidence,
    });

    for (const q of answered) pendingFlags.delete(`${interview.id}:${q.position}`);

    // A live interview has no unasked plan, so the report's "worth practising
    // anyway" list is filled from the bank: the essentials the officer never
    // reached, then the questions this conversation was heading towards.
    if (Array.isArray(interview.requiredTopics)) {
      // `questions` includes one left open if the student pressed End - it
      // stays in the list, and is not suggested twice.
      const suggestions = interviewer.practiceSuggestions({
        rows: questions,
        requiredTopics: interview.requiredTopics,
        pool: questionPool(interview.profileSnapshot),
        mode: interview.mode,
      });
      let position = Math.max(...questions.map((q) => q.position)) + 1;
      for (const suggestion of suggestions) {
        db.addQuestion(interview.id, {
          position: position++,
          category: suggestion.category,
          question: suggestion.question,
          isRequired: suggestion.required,
          topic: suggestion.topic,
          origin: "suggested",
        });
      }
    }

    db.addNotification(user.id, {
      kind: "result",
      title: `${report.rankLabel}: interview scored ${report.overallScore}/100`,
      body: `${report.rankHeadline} ${report.categoryScores[0] ? `Weakest area: ${report.categoryScores[0].category}.` : ""}`.trim(),
    });

    return { results: withStory(db.getFullInterview(interview.id)) };
  },

  /**
   * "Practise this answer again" from the report. Scores the new attempt
   * against the original, and never touches the interview's score, rank or
   * verdict - those stay a record of what was said at the window.
   */
  async retryAnswer(req, params, body) {
    const user = requireUser(req);
    rateLimit(req, "ai");

    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");
    if (interview.status !== "completed") throw new HttpError(409, "Finish the interview before practising answers.");

    const position = Number.parseInt(params.position, 10);
    const original = db.getQuestions(interview.id).find((q) => q.position === position);
    if (!original?.answer) throw notFound("That question was not answered in this interview.");

    const answer = str(body?.answer, 4000);
    if (!answer) throw badRequest("Say or type your new answer first.");

    const review = ai.reviewRetry({
      question: original.question,
      category: original.category,
      topic: original.topic,
      answer,
      profile: interview.profileSnapshot ?? db.getProfile(user.id),
      mode: interview.mode,
      position,
    });
    db.addRetry(interview.id, position, { ...review, answer });

    return {
      scores: review.scores,
      feedback: review.feedback,
      redFlags: review.redFlags.map((f) => ({ label: f.label, severity: f.severity })),
      spoken: review.spoken,
      before: original.scores,
      change: ai.answerQuality(review.scores) - ai.answerQuality(original.scores),
      retries: db.getRetries(interview.id)[position] ?? [],
    };
  },

  async interviewResults(req, params) {
    const user = requireUser(req);
    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");
    if (interview.status !== "completed") throw new HttpError(409, "This interview is not finished yet.");
    return { results: withStory(db.getFullInterview(interview.id)) };
  },

  /* ---- personal document checklist ---- */

  async documents(req) {
    const user = requireUser(req);
    return checklistFor(user.id);
  },

  async saveDocuments(req, _params, body) {
    const user = requireUser(req);
    const { items } = documentChecklist(db.getProfile(user.id));
    db.saveChecklistDone(user.id, cleanDone(body?.done, items));
    return checklistFor(user.id);
  },

  async analytics(req) {
    const user = requireUser(req);
    return {
      analytics: {
        ...db.analytics(user.id),
        story: ai.storyConsistency(completedInterviews(user.id), db.getProfile(user.id)),
      },
    };
  },

  /* ---- coaching ---- */

  async askCustomQuestion(req, _params, body) {
    const user = requireUser(req);
    rateLimit(req, "ai");

    const question = str(body?.question, 600);
    if (question.length < 5) throw badRequest("Ask a full question so the answer can be specific.");

    const profile = db.getProfile(user.id);
    const result = await ai.customAnswer(profile, question);
    const entry = db.saveCustomQuestion(user.id, { question, ...result });
    if (result.guarded) {
      // The AI wrote an answer that contradicted the student's file; it was
      // replaced. Logged so the rate of this can be watched.
      logger.warn("coach answer rejected for contradicting the file", { userId: user.id, reason: result.guarded });
    }
    // premiseConflict is not stored - it only changes how this reply is shown.
    return { entry: { ...entry, premiseConflict: Boolean(result.premiseConflict) } };
  },

  async listCustomQuestions(req) {
    const user = requireUser(req);
    return { entries: db.listCustomQuestions(user.id) };
  },

  /* ---- admin (aggregates only) ---- */

  /**
   * NIEC staff reporting.
   *
   * These three endpoints return counts, dates and scores. None of them
   * decrypts an answer, a profile field or coaching text - students were told
   * nobody reads those, and the privacy policy says so. If that ever needs to
   * change it should be a student-facing opt-in, not a widening here.
   */
  async adminOverview(req) {
    requireAdmin(req);
    return { overview: db.adminOverview(), engine: ai.engineName(), model: config.ai.enabled ? config.ai.model : null };
  },

  async adminStudents(req) {
    requireAdmin(req);
    return { students: db.adminStudents() };
  },

  /**
   * The System page: launch readiness (the same checks as
   * scripts/preflight.mjs), backups, recent server errors and the engine in
   * use. Nothing about any student.
   */
  async adminSystem(req) {
    requireAdmin(req);
    const checks = runChecks();
    const problems = recentProblems();
    return {
      checks,
      summary: {
        fail: checks.filter((c) => c.status === "fail").length,
        warn: checks.filter((c) => c.status === "warn").length,
      },
      backups: backupStatus(),
      errors: { lastSevenDays: problems.errors, latest: problems.latest },
      runtime: {
        node: process.versions.node,
        env: config.env,
        uptimeHours: Math.round((process.uptime() / 3600) * 10) / 10,
        engine: ai.engineName(),
        model: config.ai.enabled ? config.ai.model : null,
      },
    };
  },

  async adminDataRequests(req) {
    requireAdmin(req);
    return { requests: db.adminDataRequests() };
  },

  async adminCompleteRequest(req, params) {
    const admin = requireAdmin(req);
    const request = db.completeDataRequest(params.id);
    if (!request) throw notFound("Request not found.");
    logger.info("data request marked complete", { requestId: params.id, by: admin.id });
    return { requests: db.adminDataRequests() };
  },

  /* ---- question bank (staff) ---- */

  /** The whole bank: the built-in topics and every uploaded question. */
  async adminQuestions(req) {
    requireAdmin(req);
    return bankPayload();
  },

  /**
   * Add questions from pasted text or an uploaded .txt / .csv. Each is sorted
   * into a topic and category, and duplicates of anything already in the bank
   * are skipped, so the same file can be uploaded twice safely.
   */
  /**
   * How a list would be read, without saving anything: every question with
   * its category and topic, which are already in the bank, and every skipped
   * line with the reason. The admin screen shows this before "Add".
   */
  async adminPreviewQuestions(req, _params, body) {
    requireAdmin(req);
    const { items, skipped } = parseUpload(body);
    const inBank = new Set(db.listBankQuestions().map((q) => interviewer.normalizeQuestion(q.question)));
    const seen = new Set();
    const preview = items.map((item) => {
      const norm = interviewer.normalizeQuestion(item.question);
      const duplicate = inBank.has(norm) ? "already in the bank" : seen.has(norm) ? "repeated in this list" : null;
      seen.add(norm);
      return { ...item, duplicate };
    });
    return {
      items: preview,
      skipped,
      counts: {
        new: preview.filter((q) => !q.duplicate).length,
        duplicates: preview.filter((q) => q.duplicate).length,
        skipped: skipped.length,
      },
    };
  },

  async adminAddQuestions(req, _params, body) {
    const admin = requireAdmin(req);
    const { items, skipped } = parseUpload(body);
    const { added, duplicates } = db.addBankQuestions(items, {
      createdBy: admin.id,
      normalize: interviewer.normalizeQuestion,
    });
    logger.info("question bank upload", { by: admin.id, added: added.length, duplicates, skipped: skipped.length });
    return { added, duplicates, skipped, ...bankPayload() };
  },

  async adminUpdateQuestion(req, params, body) {
    requireAdmin(req);
    if (typeof body?.active !== "boolean") throw badRequest("Say whether the question is active.");
    if (!db.setBankQuestionActive(params.id, body.active)) throw notFound("Question not found.");
    return bankPayload();
  },

  async adminDeleteQuestion(req, params) {
    const admin = requireAdmin(req);
    if (!db.deleteBankQuestion(params.id)) throw notFound("Question not found.");
    logger.info("question deleted from bank", { questionId: params.id, by: admin.id });
    return bankPayload();
  },

  /**
   * Errors the browser hit, reported by the page itself.
   *
   * Without this, a JavaScript error on a student's phone is invisible - the
   * page half-breaks and nobody ever hears about it. Deliberately open to
   * signed-out visitors (the landing page can break too) but rate-limited and
   * capped, so it cannot be used to flood the log.
   */
  async reportClientError(req, _params, body) {
    rateLimit(req, "clientError");
    const session = currentUser(req);

    logger.error("browser error", {
      message: str(body?.message, 300) || "(no message)",
      source: str(body?.source, 300),
      line: Number(body?.line) || null,
      column: Number(body?.column) || null,
      stack: str(body?.stack, 2000),
      page: str(body?.page, 200),
      userAgent: str(req.headers["user-agent"], 200),
      userId: session?.user?.id ?? null,
    });

    return { received: true };
  },
};

/**
 * Red flags live in memory between answering and finishing, because they are
 * derived data. If the process restarted mid-interview they are recomputed
 * from the stored answer instead.
 */
const pendingFlags = new Map();

function recomputeFlags(question, interview) {
  return ai.redFlagsFor({
    question: question.question,
    category: question.category,
    answer: question.answer,
    profile: interview.profileSnapshot ?? {},
    scores: question.scores,
    position: question.position,
  });
}

/* ---------------------------------- routes --------------------------------- */

/** method, path pattern (with :params), handler. This is the API index. */
const ROUTES = [
  ["GET", "/health", handlers.health],
  ["GET", "/api/config", handlers.publicConfig],

  ["POST", "/api/auth/register", handlers.register],
  ["POST", "/api/auth/login", handlers.login],
  ["POST", "/api/auth/staff-login", handlers.staffLogin],
  ["POST", "/api/auth/google", handlers.googleAuth],
  ["POST", "/api/auth/logout", handlers.logout],
  ["POST", "/api/auth/forgot-password", handlers.forgotPassword],
  ["POST", "/api/auth/reset-password", handlers.resetPassword],

  ["GET", "/api/me", handlers.me],
  ["GET", "/api/profile", handlers.getProfile],
  ["PUT", "/api/profile", handlers.saveProfile],
  ["GET", "/api/preferences", handlers.getPreferences],
  ["PUT", "/api/preferences", handlers.savePreferences],
  ["GET", "/api/notifications", handlers.notifications],
  ["POST", "/api/notifications/read", handlers.readNotifications],
  ["GET", "/api/data-requests", handlers.listDataRequests],
  ["POST", "/api/data-requests", handlers.createDataRequest],
  ["GET", "/api/data-export", handlers.exportData],

  ["POST", "/api/interviews", handlers.startInterview],
  ["GET", "/api/interviews", handlers.listInterviews],
  ["GET", "/api/interviews/:id", handlers.getInterviewState],
  ["POST", "/api/interviews/:id/answer", handlers.submitAnswer],
  ["POST", "/api/interviews/:id/finish", handlers.finishInterview],
  ["POST", "/api/interviews/:id/questions/:position/retry", handlers.retryAnswer],
  ["GET", "/api/interviews/:id/results", handlers.interviewResults],
  ["GET", "/api/analytics", handlers.analytics],
  ["GET", "/api/documents", handlers.documents],
  ["PUT", "/api/documents", handlers.saveDocuments],

  ["POST", "/api/custom-questions", handlers.askCustomQuestion],
  ["GET", "/api/custom-questions", handlers.listCustomQuestions],

  ["POST", "/api/client-error", handlers.reportClientError],

  // Admin. Every one of these is behind requireAdmin and returns aggregates
  // only - never another student's answers, profile or coaching text.
  ["GET", "/api/admin/overview", handlers.adminOverview],
  ["GET", "/api/admin/students", handlers.adminStudents],
  ["GET", "/api/admin/data-requests", handlers.adminDataRequests],
  ["POST", "/api/admin/data-requests/:id/complete", handlers.adminCompleteRequest],
  ["GET", "/api/admin/system", handlers.adminSystem],
  ["GET", "/api/admin/questions", handlers.adminQuestions],
  ["POST", "/api/admin/questions", handlers.adminAddQuestions],
  ["POST", "/api/admin/questions/preview", handlers.adminPreviewQuestions],
  ["PATCH", "/api/admin/questions/:id", handlers.adminUpdateQuestion],
  ["DELETE", "/api/admin/questions/:id", handlers.adminDeleteQuestion],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split("/");
    const pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) continue;

    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i++) {
      const expected = patternParts[i];
      const actual = pathParts[i];
      if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
      else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }
  return null;
}

/* --------------------------------- server ---------------------------------- */

export function createServer() {
  db.init();

  return http.createServer(async (req, res) => {
    applyCors(req, res);
    securityHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const route = matchRoute(req.method, pathname);

    // One log line per request, whatever happens to it.
    const finish = (status) =>
      logger.request({
        method: req.method,
        path: pathname,
        status,
        ms: Date.now() - started,
        userId: currentUser(req)?.user?.id ?? null,
        ip: clientIp(req),
      });

    if (!route) {
      send(res, 404, { error: "Unknown endpoint." });
      finish(404);
      return;
    }

    try {
      rateLimit(req, "general");
      const limit = pathname.startsWith("/api/admin/questions") ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES;
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req, limit) : {};
      const payload = await route.handler(req, route.params, body);
      send(res, 200, payload ?? {});
      finish(200);
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {};
        send(res, error.status, { error: error.message }, headers);
        finish(error.status);
        return;
      }

      // An unexpected failure. The student gets a neutral message; the log
      // gets everything needed to find it: route, params, user and stack.
      const reference = Math.random().toString(36).slice(2, 8).toUpperCase();
      logger.error(`unhandled error in ${req.method} ${pathname}`, {
        reference,
        params: route.params,
        userId: currentUser(req)?.user?.id ?? null,
        error,
      });
      send(res, 500, {
        error: `Something went wrong on our side. Please try again. (Reference ${reference})`,
      });
      finish(500);
    }
  });
}

/**
 * Last-resort handlers.
 *
 * A crash is logged with its stack before the process exits, so the reason is
 * still there after the supervisor in start.mjs restarts it. Exiting is
 * deliberate: after an uncaught exception the process state is unknown, and a
 * clean restart is safer than limping on.
 */
function installCrashHandlers() {
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception - restarting", { error });
    setTimeout(() => process.exit(1), 100);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", {
      error: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });

  process.on("SIGTERM", () => {
    logger.info("received SIGTERM, shutting down");
    process.exit(0);
  });
}

export function start() {
  assertProductionSecrets();
  installCrashHandlers();

  const server = createServer();
  server.listen(config.backendPort, config.host, () => {
    logger.info(`API listening on http://${config.host}:${config.backendPort}`, {
      engine: ai.engineName(),
      model: config.ai.enabled ? config.ai.model : null,
      database: config.databaseFile,
      logFile: logger.location(),
      env: config.env,
    });
    if (usingDevSecrets && !config.isProduction) {
      logger.warn("using development secrets - set SESSION_SECRET and DATA_ENCRYPTION_KEY before deploying");
    }
  });

  server.on("error", (error) => {
    logger.error("the HTTP server could not start", { error, port: config.backendPort });
    process.exit(1);
  });

  return server;
}

// `node backend/src/server.mjs` starts the API on its own.
if (process.argv[1] && process.argv[1].endsWith("server.mjs")) start();
