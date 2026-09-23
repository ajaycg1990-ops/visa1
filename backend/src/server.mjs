import http from "node:http";
import { config, assertProductionSecrets, usingDevSecrets } from "./config.mjs";
import * as db from "./db.mjs";
import * as ai from "./ai.mjs";
import { logger } from "./logger.mjs";
import { isEmail, passwordProblem, verifyPassword } from "./security.mjs";

/**
 * The API server.
 *
 * Plain node:http with a small router - no framework, no dependencies, so the
 * product runs straight from a clone. Every route is declared in ROUTES at the
 * bottom of the file, which doubles as the API index.
 */

const MAX_BODY_BYTES = 256 * 1024;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

function publicQuestion(question, total, answered) {
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
 * Insert a follow-up drill directly after `position`, keeping the interview at
 * its planned length by dropping the last unanswered planned question.
 */
function insertFollowUp(interviewId, position, drill) {
  const questions = db.getQuestions(interviewId);
  const followUpCount = questions.filter((q) => q.isFollowUp).length;
  if (followUpCount >= MAX_FOLLOW_UPS) return false;

  const lastPlanned = [...questions].reverse().find((q) => !q.answer && !q.isFollowUp);
  if (!lastPlanned || lastPlanned.position <= position) return false;

  db.dropQuestion(interviewId, lastPlanned.position);
  db.shiftQuestionsAfter(interviewId, position);
  db.addQuestion(interviewId, {
    position: position + 1,
    category: drill.category,
    question: drill.question,
    isFollowUp: true,
  });
  return true;
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
      aiProvider: config.ai.enabled ? config.ai.model : null,
      engine: ai.engineName(),
      modes: Object.values(ai.MODES).map((m) => ({ id: m.id, name: m.name, blurb: m.blurb, greeting: m.greeting })),
      questionCount: ai.DEFAULT_QUESTION_COUNT,
      categories: ai.CATEGORIES,
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

    // In development, hand the link back so the flow works with no mail provider.
    if (!delivery.delivered && !config.isProduction) {
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

    const mode = ["strict", "neutral", "casual"].includes(body?.mode) ? body.mode : "neutral";
    const profile = db.getProfile(user.id);
    if (!profile) throw badRequest("Complete your applicant profile before starting an interview.");

    const { questions, engine, model } = await ai.generateQuestions(profile, mode, ai.DEFAULT_QUESTION_COUNT);
    const interviewId = db.createInterview({
      userId: user.id,
      mode,
      questionCount: questions.length,
      profileSnapshot: profile,
      engine,
    });

    questions.forEach((question, index) => {
      db.addQuestion(interviewId, {
        position: index,
        category: question.category,
        question: question.question,
        isFollowUp: false,
      });
    });

    const first = pendingQuestion(interviewId);
    return {
      id: interviewId,
      mode,
      engine,
      model,
      greeting: ai.MODES[mode].greeting,
      total: questions.length,
      question: publicQuestion(first, questions.length, 0),
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
    const pending = questions.find((q) => !q.answer) ?? null;

    return {
      id: interview.id,
      mode: interview.mode,
      status: interview.status,
      total: questions.length,
      answered,
      greeting: ai.MODES[interview.mode]?.greeting ?? "",
      question: pending ? publicQuestion(pending, questions.length, answered) : null,
      transcript: questions
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
   * Submit one answer. Returns the per-answer scoring immediately, then either
   * the next question (which may be a follow-up drill) or done: true.
   */
  async submitAnswer(req, params, body) {
    const user = requireUser(req);
    rateLimit(req, "ai");

    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");
    if (interview.status !== "in_progress") throw new HttpError(409, "This interview is already finished.");

    const answer = str(body?.answer, 4000);
    if (!answer) throw badRequest("Say or type something before moving on.");
    const seconds = Math.max(0, Math.round(Number(body?.seconds) || 0));

    const pending = pendingQuestion(interview.id);
    if (!pending) throw new HttpError(409, "There is no open question to answer.");

    const profile = interview.profileSnapshot ?? db.getProfile(user.id);
    const review = await ai.reviewAnswer({
      question: pending.question,
      category: pending.category,
      answer,
      seconds,
      profile,
      mode: interview.mode,
      position: pending.position,
    });

    db.saveAnswer(interview.id, pending.position, {
      answer,
      seconds,
      scores: review.scores,
      feedback: review.feedback,
      coaching: review.coaching,
    });
    // Red flags are stashed on the question row's insights at finish time.
    pendingFlags.set(`${interview.id}:${pending.position}`, review.redFlags);

    // Does the officer drill into that answer? Only planned questions are
    // drilled: a follow-up to a follow-up drifts off the topic, because the
    // drill text no longer identifies which bank question is being tested.
    if (!pending.isFollowUp) {
      const asked = db.getQuestions(interview.id).map((q) => q.question);
      const drill = ai.followUpFor({
        mode: interview.mode,
        question: pending.question,
        category: pending.category,
        answer,
        alreadyAsked: asked,
      });
      if (drill) insertFollowUp(interview.id, pending.position, drill);
    }

    const questions = db.getQuestions(interview.id);
    const answeredCount = questions.filter((q) => q.answer).length;
    const next = questions.find((q) => !q.answer) ?? null;

    return {
      scores: review.scores,
      feedback: review.feedback,
      answered: answeredCount,
      total: questions.length,
      done: !next,
      question: next ? publicQuestion(next, questions.length, answeredCount) : null,
    };
  },

  /** Close the interview and produce the full report. */
  async finishInterview(req, params) {
    const user = requireUser(req);
    rateLimit(req, "ai");

    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");
    if (interview.status === "completed") return { results: db.getFullInterview(interview.id) };

    const questions = db.getQuestions(interview.id);
    const answered = questions.filter((q) => q.answer);
    if (!answered.length) throw new HttpError(409, "Answer at least one question before finishing.");

    // Re-attach the red flags raised while answering.
    const enriched = answered.map((q) => ({
      ...q,
      redFlags: pendingFlags.get(`${interview.id}:${q.position}`) ?? recomputeFlags(q, interview),
    }));

    const report = ai.buildReport({
      questions: enriched,
      mode: interview.mode,
      profile: interview.profileSnapshot,
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
    });

    for (const q of answered) pendingFlags.delete(`${interview.id}:${q.position}`);

    db.addNotification(user.id, {
      kind: "result",
      title: `Interview scored ${report.overallScore}/100`,
      body: `${report.verdict}. ${report.categoryScores[0] ? `Weakest area: ${report.categoryScores[0].category}.` : ""}`.trim(),
    });

    return { results: db.getFullInterview(interview.id) };
  },

  async interviewResults(req, params) {
    const user = requireUser(req);
    const interview = db.getInterview(params.id);
    if (!interview || interview.userId !== user.id) throw notFound("Interview not found.");
    if (interview.status !== "completed") throw new HttpError(409, "This interview is not finished yet.");
    return { results: db.getFullInterview(interview.id) };
  },

  async analytics(req) {
    const user = requireUser(req);
    return { analytics: db.analytics(user.id) };
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
    return { entry };
  },

  async listCustomQuestions(req) {
    const user = requireUser(req);
    return { entries: db.listCustomQuestions(user.id) };
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
  ["GET", "/api/interviews/:id/results", handlers.interviewResults],
  ["GET", "/api/analytics", handlers.analytics],

  ["POST", "/api/custom-questions", handlers.askCustomQuestion],
  ["GET", "/api/custom-questions", handlers.listCustomQuestions],

  ["POST", "/api/client-error", handlers.reportClientError],
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
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};
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
