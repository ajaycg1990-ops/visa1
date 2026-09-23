import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end test of the whole API journey.
 *
 *   node tests/e2e.mjs
 *
 * Starts a real backend against a throwaway database in the system temp
 * directory, then walks the full student journey:
 *
 *   register -> save profile -> start mock -> answer every question ->
 *   finish and score -> read results -> analytics -> custom Q&A ->
 *   notifications -> preferences -> data access request ->
 *   forgot password -> reset password -> sign in with the new password
 *
 * Nothing is mocked. Exit code 0 means the product works end to end.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number.parseInt(process.env.E2E_PORT || "4321", 10);
const BASE = `http://127.0.0.1:${PORT}`;

const workDir = mkdtempSync(path.join(tmpdir(), "niec-e2e-"));
const dbFile = path.join(workDir, "e2e.sqlite");

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

let token = null;

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ...payload };
}

async function waitForServer(attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const server = spawn(process.execPath, [path.join(ROOT, "backend", "src", "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(PORT),
    DATABASE_FILE: dbFile,
    SEED_DEMO: "0",
    SESSION_SECRET: "e2e-session-secret",
    DATA_ENCRYPTION_KEY: "e2e-encryption-key",
    AI_API_KEY: "", // force the built-in engine, so the test never hits the network
    RATE_LIMIT_AUTH: "500",
    RATE_LIMIT_AI: "500",
    RATE_LIMIT_GENERAL: "5000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", () => {});
server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

function cleanup(code) {
  server.kill();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best effort */
  }
  process.exit(code);
}

try {
  console.log(`NIEC Visa AI - end-to-end test\ntemporary database: ${dbFile}`);

  if (!(await waitForServer())) {
    console.error("Backend did not start.");
    cleanup(1);
  }

  /* ------------------------------------------------------------ health --- */
  section("Health and public config");
  const health = await call("GET", "/health");
  check("health endpoint responds", health.status === "ok", JSON.stringify(health));
  const publicConfig = await call("GET", "/api/config");
  check("public config lists 3 officer modes", publicConfig.modes?.length === 3);
  check("built-in engine is active without an API key", publicConfig.engine === "built-in");

  /* --------------------------------------------------------- register --- */
  section("Registration and session");
  const email = `e2e_${Date.now()}@example.com`;
  const firstPassword = "TestPass123";

  const weak = await call("POST", "/api/auth/register", { fullName: "E2E Student", email, password: "short" });
  check("weak password is rejected", weak.status === 400, weak.error);

  const registered = await call("POST", "/api/auth/register", {
    fullName: "E2E Student",
    email,
    password: firstPassword,
  });
  check("account is created", Boolean(registered.token), registered.error);
  token = registered.token;

  const duplicate = await call("POST", "/api/auth/register", {
    fullName: "E2E Student",
    email,
    password: firstPassword,
  });
  check("duplicate email is rejected", duplicate.status === 409);

  const unauth = await fetch(`${BASE}/api/me`).then((r) => r.status);
  check("protected route rejects anonymous callers", unauth === 401);

  const me = await call("GET", "/api/me");
  check("session resolves to the new user", me.user?.email === email, JSON.stringify(me));
  check("welcome notification was created", me.unreadNotifications >= 1);

  /* ---------------------------------------------------------- profile --- */
  section("Applicant profile");
  const profileInput = {
    fullName: "E2E Student",
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
    whyUsa: "The applied data-systems specialisation is not offered at home.",
    whyProgram: "The analytics capstone matches the work I want to do.",
    careerGoal: "Data engineer in Nepal's fintech sector",
    planAfter: "Return to Kathmandu and join a payments company.",
    tiesHome: "Family business and property in Kathmandu.",
    previousApplications: "None",
    refusals: "No",
    refusalReason: "",
    relativesInUs: "Cousin, student visa, Texas",
    travelHistory: "India 2023",
  };

  const saved = await call("PUT", "/api/profile", profileInput);
  check("profile saves", saved.profile?.usUniversity === "Texas State University", saved.error);
  check("completeness is reported", saved.completeness > 80, String(saved.completeness));

  const reread = await call("GET", "/api/profile");
  check("encrypted profile decrypts on read", reread.profile?.sponsorRelation === "Father");

  /* -------------------------------------------------------- interview --- */
  section("Mock interview");
  const started = await call("POST", "/api/interviews", { mode: "strict" });
  check("interview starts", Boolean(started.id), started.error);
  check("ten questions are planned", started.total === 10, String(started.total));
  check("first question is personalised", /Texas State|gap|relatives/i.test(started.question?.question || ""), started.question?.question);

  const interviewId = started.id;
  const answers = [
    "I researched four universities myself and chose Texas State for the applied data-systems track in its MS Computer Science.",
    "It is a two year programme, 36 credits, and I am taking the analytics capstone and the distributed systems core course.",
    "My father sponsors me. He owns a construction supply business earning about 22000 dollars a year, and we hold 40000 dollars in documented savings.",
    "My first year costs 34000 dollars on my I-20, covered by savings and a 6000 dollar scholarship, so I do not need to work.",
    "I return to Kathmandu after graduating to work as a data engineer in the fintech sector, where my family business also operates.",
    "I used the gap year to work at a software firm and complete two certifications before applying.",
    "Yes, my cousin studies in Texas. He is not funding me and I am not depending on him.",
    "I have a genuine admission, documented funding, and a specific job market waiting at home in Nepal.",
    "My parents, our family business and our property are all in Kathmandu, so returning is the plan I have built for.",
    "If I do not find a role immediately I join the family business, which already hires technical staff.",
    "I answer that from my own case, with the numbers already on my I-20 and in my bank statements.",
    "My plan has not changed: finish the degree, return to Nepal, and build payment systems there.",
    "That is correct, and every figure I gave matches the documents in this folder.",
  ];

  let answerIndex = 0;
  let last = null;
  let guard = 0;

  while (guard < 20) {
    guard += 1;
    const response = await call("POST", `/api/interviews/${interviewId}/answer`, {
      answer: answers[answerIndex % answers.length],
      seconds: 22,
    });
    if (response.status && response.status >= 400) {
      check("answer submission succeeds", false, response.error);
      break;
    }
    answerIndex += 1;
    last = response;
    if (response.done) break;
  }

  check("interview completed all questions", last?.done === true, JSON.stringify(last));
  check("per-answer scores are returned", typeof last?.scores?.answer === "number" && typeof last?.scores?.tone === "number" && typeof last?.scores?.clarity === "number");
  check("follow-up drills kept the interview at ten questions", last?.total === 10, String(last?.total));

  const empty = await call("POST", `/api/interviews/${interviewId}/answer`, { answer: "", seconds: 1 });
  check("empty answers are rejected", empty.status === 400 || empty.status === 409);

  /* ----------------------------------------------------------- report --- */
  section("Scoring and report");
  const finished = await call("POST", `/api/interviews/${interviewId}/finish`);
  const report = finished.results;
  check("report is produced", Boolean(report), finished.error);
  check("overall score is in range", report.overallScore > 0 && report.overallScore <= 100, String(report?.overallScore));
  check("a verdict is set", ["Likely approved", "Borderline", "Likely refused"].includes(report.verdict), report?.verdict);
  check("category scores exist", report.categoryScores?.length >= 3, String(report?.categoryScores?.length));
  check("every answer has coaching", report.questions.filter((q) => q.answer).every((q) => q.whatToSay && q.howToSayIt && q.whyItWorks && q.improvedAnswer));
  check("insights include recommendations", report.insights?.some((i) => i.kind === "recommendation"));
  check("summary is written", typeof report.summary === "string" && report.summary.length > 40);

  const results = await call("GET", `/api/interviews/${interviewId}/results`);
  check("results can be re-read", results.results?.id === interviewId);

  const history = await call("GET", "/api/interviews");
  check("interview appears in history", history.interviews?.[0]?.id === interviewId);

  /* -------------------------------------------- red flags on bad answers -- */
  section("Red-flag detection");
  const risky = await call("POST", "/api/interviews", { mode: "neutral" });
  let riskyDone = false;
  const riskyAnswers = [
    "My uncle is paying for everything.",
    "I want to settle there because opportunities there are better.",
    "I will work part time job to pay my living costs.",
    "It is good.",
  ];
  for (let i = 0; i < 14 && !riskyDone; i++) {
    const response = await call("POST", `/api/interviews/${risky.id}/answer`, {
      answer: riskyAnswers[i % riskyAnswers.length],
      seconds: 6,
    });
    riskyDone = response.done === true;
  }
  const riskyReport = (await call("POST", `/api/interviews/${risky.id}/finish`)).results;
  const flagLabels = riskyReport.insights.filter((i) => i.kind === "red_flag").map((i) => i.label);
  check("sponsor mismatch is detected", flagLabels.includes("Sponsor mismatch"), flagLabels.join(", "));
  check("immigration-intent language is detected", flagLabels.includes("Immigration-intent language"), flagLabels.join(", "));
  check("work-dependence funding is detected", flagLabels.includes("Funding depends on U.S. work"), flagLabels.join(", "));
  check("a weak interview scores below a strong one", riskyReport.overallScore < report.overallScore, `${riskyReport.overallScore} vs ${report.overallScore}`);

  /* -------------------------------------------------------- analytics --- */
  section("Analytics");
  const analytics = (await call("GET", "/api/analytics")).analytics;
  check("two completed interviews are counted", analytics.completed === 2, String(analytics.completed));
  check("readiness score is produced", analytics.readiness >= 0 && analytics.readiness <= 100);
  check("category averages are aggregated", analytics.categories.length >= 3);
  check("dimension averages are aggregated", analytics.dimensions.answer > 0);

  /* ------------------------------------------------------- custom Q&A --- */
  section("Custom question coaching");
  const ask = await call("POST", "/api/custom-questions", {
    question: "How should I answer if the officer asks how I will fund my second year?",
  });
  check("coach answers the question", (ask.entry?.answer || "").length > 40, ask.error);
  check("coaching includes what/how/why", Boolean(ask.entry?.whatToSay && ask.entry?.howToSayIt && ask.entry?.whyItWorks));
  check("answer is personalised from the profile", /34000|father|Texas State|savings/i.test(ask.entry.answer), ask.entry.answer);

  const askShort = await call("POST", "/api/custom-questions", { question: "hi" });
  check("very short questions are rejected", askShort.status === 400);

  const askHistory = await call("GET", "/api/custom-questions");
  check("Q&A history is saved", askHistory.entries?.length === 1);

  /* --------------------------------------------- notifications and prefs -- */
  section("Notifications, preferences and privacy");
  const notifications = await call("GET", "/api/notifications");
  check("result notification was created", notifications.notifications.some((n) => n.kind === "result"));
  await call("POST", "/api/notifications/read", { all: true });
  const afterRead = await call("GET", "/api/notifications");
  check("notifications can be marked read", afterRead.unread === 0);

  const prefs = await call("PUT", "/api/preferences", { theme: "dark", marketingOptIn: false, productEmails: true });
  check("preferences save", prefs.preferences.theme === "dark" && prefs.preferences.marketingOptIn === false);

  const dataRequest = await call("POST", "/api/data-requests", { kind: "access" });
  check("data access request is logged", dataRequest.request?.kind === "access", dataRequest.error);

  const exported = await call("GET", "/api/data-export");
  check("data export contains the profile", exported.profile?.usUniversity === "Texas State University");
  check("data export contains interviews", exported.interviews?.length === 2);

  /* ------------------------------------------------- password recovery --- */
  section("Password reset");
  const forgot = await call("POST", "/api/auth/forgot-password", { email });
  check("reset request is accepted", forgot.sent === true, forgot.error);
  check("dev reset link is returned when no mail provider is set", typeof forgot.devResetUrl === "string", JSON.stringify(forgot));

  const resetToken = new URL(forgot.devResetUrl.replace("/#/", "/")).searchParams.get("token");
  check("reset token is present in the link", Boolean(resetToken));

  const newPassword = "BrandNewPass456";
  const reset = await call("POST", "/api/auth/reset-password", { token: resetToken, password: newPassword });
  check("password reset succeeds", Boolean(reset.token), reset.error);

  const reuse = await call("POST", "/api/auth/reset-password", { token: resetToken, password: "AnotherPass789" });
  check("reset tokens are single-use", reuse.status === 400);

  token = null;
  const oldLogin = await call("POST", "/api/auth/login", { email, password: firstPassword });
  check("old password no longer works", oldLogin.status === 401);

  const newLogin = await call("POST", "/api/auth/login", { email, password: newPassword });
  check("new password signs in", Boolean(newLogin.token), newLogin.error);
  token = newLogin.token;

  const finalMe = await call("GET", "/api/me");
  check("session works after reset", finalMe.user?.email === email);

  /* ------------------------------------------------------------ access --- */
  section("Access control");
  const otherEmail = `e2e_other_${Date.now()}@example.com`;
  const other = await call("POST", "/api/auth/register", {
    fullName: "Other Student",
    email: otherEmail,
    password: firstPassword,
  });
  token = other.token;
  const stolen = await call("GET", `/api/interviews/${interviewId}/results`);
  check("one student cannot read another's interview", stolen.status === 404, JSON.stringify(stolen));

  token = null;
  const anonymous = await call("GET", "/api/analytics");
  check("analytics requires a session", anonymous.status === 401);

  /* ------------------------------------------------------------ result --- */
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} checks passed, ${failed} failed.\n`);
  cleanup(failed === 0 ? 0 : 1);
} catch (error) {
  console.error("\nUnexpected error in the test run:", error);
  cleanup(1);
}
