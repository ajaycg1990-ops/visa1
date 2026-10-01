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
    LOG_DIR: path.join(workDir, "logs"),
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
  section("Mock interview (adaptive length)");
  const started = await call("POST", "/api/interviews", { mode: "neutral" });
  check("interview starts", Boolean(started.id), started.error);
  check("at most ten questions", started.total === 10, String(started.total));
  check("first question is a pillar: why this university", /Texas State|university/i.test(started.question?.question || ""), started.question?.question);

  /**
   * A well-prepared student answers each question on its own topic, with
   * specifics from their file. Answers are chosen by what was asked, the way a
   * real student would, so the test does not depend on question order.
   */
  const strongAnswerFor = (question) => {
    const q = question.toLowerCase();
    if (/gap|doing|since graduating/.test(q)) {
      return "I worked at a software firm in Kathmandu for a year and completed two cloud certifications, which is why I am applying now with a clear plan.";
    }
    if (/relative|cousin|live with|status/.test(q)) {
      return "Yes, my cousin studies in Texas on a student visa. He is not funding me and I will not live with him, and I return to Nepal after my studies.";
    }
    if (/business/.test(q)) {
      return "It supplies cement and steel to building contractors in Kathmandu and earns about 22000 dollars a year, documented in its tax clearance certificates.";
    }
    if (/property/.test(q)) {
      return "The property is in my father's name, a family house and land in Kathmandu, documented with the ownership certificates I carry in my file.";
    }
    if (/scholarship/.test(q)) {
      return "The 6000 dollar scholarship is renewable each year while I keep a 3.0 GPA, as stated in my award letter, and my father's savings cover the rest.";
    }
    if (/sponsor|cost|fund|pay|money|income|document|afford|bank|work/.test(q)) {
      return "My father sponsors me through his construction supply business, earning about 22000 dollars a year, and we hold 40000 dollars in documented savings covering the 34000 dollar first-year cost on my I-20.";
    }
    if (/plan|after|return|stay|home|ties|employer|role|salary|opt|job/.test(q)) {
      return "I return to Kathmandu after graduating to work as a data engineer in Nepal's fintech sector, where my parents, our family business and our property are based.";
    }
    return "I chose Texas State University for the applied data-systems track in its MS Computer Science programme, 36 credits with an analytics capstone course that matches my career plan.";
  };

  const interviewId = started.id;
  let question = started.question?.question ?? "";
  let last = null;
  let asked = 0;

  for (let guard = 0; guard < 20; guard++) {
    const response = await call("POST", `/api/interviews/${interviewId}/answer`, {
      answer: strongAnswerFor(question),
      seconds: 22,
    });
    if (response.status && response.status >= 400) {
      check("answer submission succeeds", false, response.error);
      break;
    }
    asked += 1;
    last = response;
    if (response.done) break;
    question = response.question?.question ?? "";
  }

  check("interview ends", last?.done === true, JSON.stringify(last));
  check("per-answer scores are returned", typeof last?.scores?.answer === "number" && typeof last?.scores?.tone === "number" && typeof last?.scores?.clarity === "number");
  check(
    "each answer reports how long it takes to say",
    typeof last?.spoken?.seconds === "number" && ["short", "good", "long"].includes(last?.spoken?.verdict),
    JSON.stringify(last?.spoken),
  );
  check("a convincing student is approved early", last?.endedReason === "approved_early", `${last?.endedReason} after ${asked}`);
  check("early approval comes in fewer than ten questions", asked < 10, `${asked} questions`);
  check("early approval never comes before the minimum of four", asked >= 4, `${asked} questions`);

  const afterEnd = await call("POST", `/api/interviews/${interviewId}/answer`, { answer: "One more thing.", seconds: 5 });
  check("no further answers once the officer has decided", afterEnd.status === 409, `got ${afterEnd.status}`);

  const empty = await call("POST", `/api/interviews/${interviewId}/answer`, { answer: "", seconds: 1 });
  check("empty answers are rejected", empty.status === 400 || empty.status === 409);

  /* ----------------------------------------------------------- report --- */
  section("Scoring and report");
  const finished = await call("POST", `/api/interviews/${interviewId}/finish`);
  const report = finished.results;
  check("report is produced", Boolean(report), finished.error);
  check("overall score is in range", report.overallScore > 0 && report.overallScore <= 100, String(report?.overallScore));
  check("a verdict is set", ["Likely approved", "Borderline", "Likely refused"].includes(report.verdict), report?.verdict);
  check("an early approval reads as approved in the report", report.verdict === "Likely approved", report.verdict);
  check("the strong student ranks Strong or Good", ["strong", "good"].includes(report.rank), report.rank);
  check("the report records why it ended", report.endedReason === "approved_early", report.endedReason);
  check(
    "no question is asked twice",
    new Set(report.questions.filter((q) => q.answer).map((q) => q.question.toLowerCase())).size === report.questions.filter((q) => q.answer).length
  );
  check(
    "every asked question records where it came from",
    report.questions.filter((q) => q.answer).every((q) => typeof q.origin === "string" && q.origin.length > 0),
    report.questions.map((q) => q.origin).join(", ")
  );
  check(
    "every answer records the officer's confidence for the graph",
    report.questions.filter((q) => q.answer).every((q) => typeof q.confidenceAfter === "number")
  );
  check(
    "unasked questions stay in the report for extra practice",
    report.questions.some((q) => !q.answer),
    `${report.questions.filter((q) => !q.answer).length} unasked`
  );
  check("category scores exist", report.categoryScores?.length >= 3, String(report?.categoryScores?.length));
  check("every answer has coaching", report.questions.filter((q) => q.answer).every((q) => q.whatToSay && q.howToSayIt && q.whyItWorks && q.improvedAnswer));
  check("insights include recommendations", report.insights?.some((i) => i.kind === "recommendation"));
  check("summary is written", typeof report.summary === "string" && report.summary.length > 40);

  const results = await call("GET", `/api/interviews/${interviewId}/results`);
  check("results can be re-read", results.results?.id === interviewId);

  const history = await call("GET", "/api/interviews");
  check("interview appears in history", history.interviews?.[0]?.id === interviewId);

  /* --------------------------------------------- practise one answer --- */
  section("Practise one answer again");
  const firstAnswered = results.results.questions.find((q) => q.answer);
  const retryPath = `/api/interviews/${interviewId}/questions/${firstAnswered.position}/retry`;

  const weakRetry = await call("POST", retryPath, { answer: "Because it is good." });
  check("a retry is scored", typeof weakRetry.scores?.answer === "number", weakRetry.error);
  check("a retry is compared with the interview answer", typeof weakRetry.change === "number" && weakRetry.change < 0, String(weakRetry.change));
  check("a retry reports its spoken length", weakRetry.spoken?.verdict === "short", JSON.stringify(weakRetry.spoken));

  const flaggedRetry = await call("POST", retryPath, { answer: "Honestly I want to settle in America and stay there permanently after my degree." });
  check("a retry still catches red flags", flaggedRetry.redFlags?.some((f) => f.label === "Immigration-intent language"), JSON.stringify(flaggedRetry.redFlags));

  const afterRetries = await call("GET", `/api/interviews/${interviewId}/results`);
  check("retries are kept with the report", afterRetries.results.questions.find((q) => q.position === firstAnswered.position)?.retries?.length === 2);
  check(
    "retries never change the interview's score, rank or verdict",
    afterRetries.results.overallScore === report.overallScore && afterRetries.results.rank === report.rank && afterRetries.results.verdict === report.verdict
  );

  for (let i = 0; i < 5; i++) await call("POST", retryPath, { answer: `Practice attempt number ${i}.` });
  const capped = await call("GET", `/api/interviews/${interviewId}/results`);
  check("only the last five attempts are kept", capped.results.questions.find((q) => q.position === firstAnswered.position)?.retries?.length === 5);

  const unanswered = await call("POST", `/api/interviews/${interviewId}/questions/99/retry`, { answer: "Test." });
  check("retrying a question that was never asked is refused", unanswered.status === 404, String(unanswered.status));
  const emptyRetry = await call("POST", retryPath, { answer: "  " });
  check("an empty retry is rejected", emptyRetry.status === 400, String(emptyRetry.status));

  /* -------------------------------------------- red flags on bad answers -- */
  section("Red-flag detection");
  const risky = await call("POST", "/api/interviews", { mode: "neutral" });
  let riskyDone = false;
  let riskyLast = null;
  const riskyAsked = [risky.question?.question ?? ""];
  const riskyAnswers = [
    "My uncle is paying for everything.",
    "I want to settle there because opportunities there are better.",
    "I will work part time job to pay my living costs.",
    "It is good.",
    "We have about 25,000 dollars in the bank.",
  ];
  for (let i = 0; i < 14 && !riskyDone; i++) {
    riskyLast = await call("POST", `/api/interviews/${risky.id}/answer`, {
      answer: riskyAnswers[i % riskyAnswers.length],
      seconds: 6,
    });
    riskyDone = riskyLast.done === true;
    if (riskyLast.question) riskyAsked.push(riskyLast.question.question);
  }
  const riskyReport = (await call("POST", `/api/interviews/${risky.id}/finish`)).results;
  const flagLabels = riskyReport.insights.filter((i) => i.kind === "red_flag").map((i) => i.label);
  check("sponsor mismatch is detected", flagLabels.includes("Sponsor mismatch"), flagLabels.join(", "));
  check("immigration-intent language is detected", flagLabels.includes("Immigration-intent language"), flagLabels.join(", "));
  check("work-dependence funding is detected", flagLabels.includes("Funding depends on U.S. work"), flagLabels.join(", "));
  check("a weak interview scores below a strong one", riskyReport.overallScore < report.overallScore, `${riskyReport.overallScore} vs ${report.overallScore}`);

  check("a suspicious student is questioned the full ten", riskyLast?.endedReason === "max_questions", riskyLast?.endedReason);
  check(
    "the officer challenges a red flag immediately",
    riskyAsked.some((q) => /different sponsor|plan to stay|depending on a job/i.test(q)),
    riskyAsked.join(" | ")
  );
  check("a suspicious student ranks Not ready", riskyReport.rank === "not_ready", riskyReport.rank);
  check("and the verdict agrees", riskyReport.verdict === "Likely refused", riskyReport.verdict);

  /* -------------------------------------------------------- analytics --- */
  section("Analytics");
  const analytics = (await call("GET", "/api/analytics")).analytics;
  check("two completed interviews are counted", analytics.completed === 2, String(analytics.completed));
  check("readiness score is produced", analytics.readiness >= 0 && analytics.readiness <= 100);
  check("category averages are aggregated", analytics.categories.length >= 3);
  check("dimension averages are aggregated", analytics.dimensions.answer > 0);

  /* ------------------------------------------ story across interviews --- */
  section("Your story across interviews");
  const story = analytics.story;
  check("the story checks every completed interview", story?.interviewsChecked === 2, JSON.stringify(story?.interviewsChecked));
  check(
    "a sponsor who changed from the file is caught",
    story.issues.some((i) => i.kind === "sponsor" && i.severity === "high" && /uncle/.test(i.message) && /father/.test(i.message)),
    JSON.stringify(story.issues.map((i) => i.message))
  );
  check(
    "a savings figure that leaves the file is caught",
    story.issues.some((i) => i.kind === "savings" && /25,000/.test(i.message) && /40,000/.test(i.message)),
    JSON.stringify(story.issues.map((i) => i.message))
  );
  check(
    "facts that match the file are marked consistent",
    story.facts.find((f) => f.kind === "cost")?.status === "consistent",
    JSON.stringify(story.facts.find((f) => f.kind === "cost"))
  );
  check("the strong interview's report has no story alerts", (await call("GET", `/api/interviews/${interviewId}/results`)).results.storyIssues?.length === 0);
  check("the risky interview's report carries its own story alerts", riskyReport.storyIssues?.some((i) => i.kind === "sponsor"));

  /* ------------------------------------------ personal document checklist --- */
  section("Document checklist");
  const docs = await call("GET", "/api/documents");
  const docIds = (docs.items ?? []).map((i) => i.id);
  check("the checklist has the core visa documents", ["passport", "i20", "ds160", "sevis"].every((id) => docIds.includes(id)), docIds.join(", "));
  check("a father as sponsor adds relationship proof", docIds.includes("relationship"));
  check("a business-owner sponsor adds business documents", docIds.includes("business"));
  check("a scholarship in the file adds the award letter", docIds.includes("scholarship"));
  check("a gap year adds proof of what was done", docIds.includes("gap"));
  check("no loan in the file means no loan letter", !docIds.includes("loan"));
  check("no refusal in the file means no refusal letter", !docIds.includes("refusal"));
  check("conditional items say why they are there", docs.items.filter((i) => i.because).length >= 3);

  const ticked = await call("PUT", "/api/documents", { done: ["passport", "i20", "not-a-real-item", 42] });
  check("ticks are saved", ticked.done?.includes("passport") && ticked.done?.includes("i20"), JSON.stringify(ticked.done));
  check("unknown ids are dropped", ticked.done?.length === 2, JSON.stringify(ticked.done));
  check("progress counts the ticks", ticked.progress?.done === 2 && ticked.progress.total === docIds.length, JSON.stringify(ticked.progress));
  const docsAgain = await call("GET", "/api/documents");
  check("ticks persist across reads", docsAgain.done?.length === 2);

  await call("PUT", "/api/profile", { ...profileInput, loanUsd: "8000" });
  const withLoan = await call("GET", "/api/documents");
  check("adding a loan to the file adds the loan letter", withLoan.items.some((i) => i.id === "loan"));
  check("existing ticks survive a profile change", withLoan.done?.length === 2);
  await call("PUT", "/api/profile", profileInput);

  /* ------------------------------------------------- interview-day mode --- */
  section("Interview-day mode");
  const exam = await call("POST", "/api/interviews", { examMode: true, mode: "casual" });
  check("an interview-day interview starts", Boolean(exam.id), exam.error);
  check("the officer is not revealed", exam.mode === null && exam.examMode === true, JSON.stringify({ mode: exam.mode, examMode: exam.examMode }));
  check("the length is not revealed", exam.total === null && exam.question?.total === undefined);
  check("questions carry no category label", exam.question && exam.question.category === undefined && exam.question.isFollowUp === undefined);

  let examLast = await call("POST", `/api/interviews/${exam.id}/answer`, { answer: strongAnswerFor(exam.question.question), seconds: 20 });
  check("an answer returns no scores", examLast.scores === undefined && examLast.feedback === undefined, JSON.stringify(Object.keys(examLast)));
  check("an answer returns no hints", examLast.spoken === undefined && examLast.challenged === undefined);
  check("the next question still comes", Boolean(examLast.question?.question) || examLast.done === true);

  const examState = await call("GET", `/api/interviews/${exam.id}`);
  check("no transcript on interview day", Array.isArray(examState.transcript) && examState.transcript.length === 0);
  check("resuming does not reveal the officer", examState.mode === null);

  for (let i = 0; i < 12 && !examLast.done; i++) {
    examLast = await call("POST", `/api/interviews/${exam.id}/answer`, { answer: strongAnswerFor(examLast.question.question), seconds: 20 });
  }
  const examReport = (await call("POST", `/api/interviews/${exam.id}/finish`)).results;
  check("the report reveals which officer it was", ["strict", "neutral", "casual"].includes(examReport?.mode), examReport?.mode);
  check("the report is marked interview day", examReport?.examMode === true);
  check("the report has full per-answer scores", examReport.questions.filter((q) => q.answer).every((q) => typeof q.scores.answer === "number"));
  const examHistory = await call("GET", "/api/interviews");
  check("history marks the interview-day run", examHistory.interviews.find((i) => i.id === exam.id)?.examMode === true);

  /* ------------------------------------------------------- custom Q&A --- */
  section("Custom question coaching");
  const ask = await call("POST", "/api/custom-questions", {
    question: "How should I answer if the officer asks how I will fund my second year?",
  });
  check("coach answers the question", (ask.entry?.answer || "").length > 40, ask.error);
  check("coaching includes what/how/why", Boolean(ask.entry?.whatToSay && ask.entry?.howToSayIt && ask.entry?.whyItWorks));
  check("answer is personalised from the profile", /34000|father|Texas State|savings/i.test(ask.entry.answer), ask.entry.answer);

  // Regression: the coach once answered "my sponsor is my uncle, not my
  // father" by attaching the father's name to "my uncle" - coaching the very
  // contradiction that gets students refused.
  const premise = await call("POST", "/api/custom-questions", {
    question: "My sponsor is my uncle, not my father. How do I answer that without it looking suspicious?",
  });
  check("coach flags a question that contradicts the student's file", premise.entry?.premiseConflict === true);
  check(
    "coach never attaches the file's sponsor name to a different relative",
    !/uncle[^.]*ram|ram[^.]*uncle/i.test(premise.entry?.answer ?? ""),
    premise.entry?.answer
  );
  check("coach tells the student to fix their paperwork first", /DS-160/.test(premise.entry?.warning ?? ""), premise.entry?.warning);

  const askShort = await call("POST", "/api/custom-questions", { question: "hi" });
  check("very short questions are rejected", askShort.status === 400);

  const askHistory = await call("GET", "/api/custom-questions");
  check("Q&A history is saved", askHistory.entries?.length === 2, String(askHistory.entries?.length));

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
  check("data export contains interviews", exported.interviews?.length === 3, String(exported.interviews?.length)); // strong, risky, interview day

  /* ------------------------------------------------- password recovery --- */
  section("Password reset");
  const forgot = await call("POST", "/api/auth/forgot-password", { email });
  check("reset request is accepted", forgot.sent === true, forgot.error);
  check("dev reset link is returned when no mail provider is set", typeof forgot.devResetUrl === "string", JSON.stringify(forgot));
  // A visitor arriving through a public link (the web server forwards their
  // real address) must never see a reset link - that would be an account takeover.
  const remoteForgot = await fetch(`${BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json());
  check("a reset link is never shown to someone on the internet", remoteForgot.sent === true && !("devResetUrl" in remoteForgot), JSON.stringify(remoteForgot));

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
  const stolenRetry = await call("POST", `/api/interviews/${interviewId}/questions/1/retry`, { answer: "Mine now." });
  check("one student cannot practise on another's interview", stolenRetry.status === 404, String(stolenRetry.status));

  token = null;
  const anonymous = await call("GET", "/api/analytics");
  check("analytics requires a session", anonymous.status === 401);

  /* ------------------------------------------------------ admin portal --- */
  section("Admin portal");

  // Sign back in as the second student: the point of these three checks is
  // that a *signed-in* student is refused, not merely an anonymous caller.
  token = other.token;
  for (const path of ["/api/admin/overview", "/api/admin/students", "/api/admin/data-requests", "/api/admin/system"]) {
    const blocked = await call("GET", path);
    check(`student cannot reach ${path}`, blocked.status === 404, `got ${blocked.status}`);
  }

  token = null;
  const anonAdmin = await call("GET", "/api/admin/overview");
  check("anonymous cannot reach admin", anonAdmin.status === 401, `got ${anonAdmin.status}`);

  // Promote the original student and check the admin side works.
  const { execSync } = await import("node:child_process");
  execSync(`node scripts/make-admin.mjs ${email}`, {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, DATABASE_FILE: dbFile, LOG_DIR: path.join(workDir, "logs"), SEED_DEMO: "0", DATA_ENCRYPTION_KEY: "e2e-encryption-key" },
  });

  const adminLogin = await call("POST", "/api/auth/login", { email, password: newPassword });
  check("promoted account reports role=admin", adminLogin.user?.role === "admin", adminLogin.user?.role);
  token = adminLogin.token;

  // The separate staff portal refuses students and reveals nothing about why.
  const staffAsAdmin = await call("POST", "/api/auth/staff-login", { email, password: newPassword });
  check("admin signs in at the staff portal", staffAsAdmin.user?.role === "admin", staffAsAdmin.error);

  const staffAsStudent = await call("POST", "/api/auth/staff-login", {
    email: otherEmail,
    password: firstPassword,
  });
  check("valid student account refused at the staff portal", staffAsStudent.status === 401);

  const staffWrongPassword = await call("POST", "/api/auth/staff-login", { email, password: "WrongPassword1" });
  const staffUnknown = await call("POST", "/api/auth/staff-login", {
    email: "nobody@example.com",
    password: "Whatever123",
  });
  check(
    "staff portal gives one identical refusal for student, wrong password and unknown account",
    staffAsStudent.error === staffWrongPassword.error && staffWrongPassword.error === staffUnknown.error,
    `${staffAsStudent.error} / ${staffWrongPassword.error} / ${staffUnknown.error}`
  );

  const overview = await call("GET", "/api/admin/overview");
  check("admin reads the overview", overview.overview?.totals?.students >= 1, JSON.stringify(overview.error ?? ""));
  check("overview aggregates interviews", overview.overview?.totals?.interviews >= 2);

  const adminStudents = await call("GET", "/api/admin/students");
  check("admin lists accounts", adminStudents.students?.length >= 2);

  const system = await call("GET", "/api/admin/system");
  check("admin sees the launch-readiness checks", Array.isArray(system.checks) && system.checks.some((c) => c.label === "DATA_ENCRYPTION_KEY"), system.error);
  check("every check has a pass, warn or fail status", system.checks?.every((c) => ["pass", "warn", "fail"].includes(c.status)));
  check("the system page counts blockers and warnings", typeof system.summary?.fail === "number" && typeof system.summary?.warn === "number");
  check("the system page reports runtime and errors", typeof system.runtime?.uptimeHours === "number" && typeof system.errors?.lastSevenDays === "number");
  check(
    "no secret appears on the system page",
    !JSON.stringify(system).includes("e2e-encryption-key") && !JSON.stringify(system).includes("e2e-session-secret")
  );

  const adminRequests = await call("GET", "/api/admin/data-requests");
  check("admin sees the data request raised earlier", adminRequests.requests?.length >= 1);

  if (adminRequests.requests?.length) {
    const completed = await call("POST", `/api/admin/data-requests/${adminRequests.requests[0].id}/complete`);
    check("admin can mark a data request done", completed.requests?.[0]?.status === "completed");
  }

  // The privacy promise: aggregates only. A leak here would mean staff can
  // read financial details students were told nobody sees.
  const adminPayload = JSON.stringify([overview, adminStudents, adminRequests]);
  const secrets = ["Texas State", "Ram Bahadur", "construction supply", "34000", "I chose", "fintech"];
  const leaked = secrets.filter((word) => adminPayload.includes(word));
  check("no answers, profile fields or financials in any admin response", leaked.length === 0, leaked.join(", "));

  /* ------------------------------------------------ question bank (staff) --- */
  section("Question bank (staff upload)");
  const bankUpload = [
    "# NIEC question bank",
    "1. What made you choose {university} of all places?",
    "2) What does your father do for a living?",
    "Financial | How will you pay for your second year?",
    "[Intent] Why would you come back to Nepal?",
    "Is your education loan sanctioned yet?",
    "What is your hobby?",
    "ok",
  ].join("\n");
  const uploadedBank = await call("POST", "/api/admin/questions", { text: bankUpload });
  check("staff can upload a question list", uploadedBank.added?.length === 6, uploadedBank.error ?? String(uploadedBank.added?.length));
  check("junk lines are skipped, not stored", uploadedBank.skipped?.length === 1, JSON.stringify(uploadedBank.skipped));
  const uploadedQ = (words) => uploadedBank.added?.find((q) => q.question.includes(words));
  check(
    "uploaded questions are sorted into topics",
    uploadedQ("father do")?.topic === "sponsor" && uploadedQ("come back")?.topic === "ties" && uploadedQ("{university}")?.topic === "uni_choice" && uploadedQ("loan")?.topic === "loan",
    JSON.stringify(uploadedBank.added?.map((q) => [q.question.slice(0, 30), q.topic]))
  );
  check("numbering is stripped", uploadedQ("father do")?.question === "What does your father do for a living?");
  check("a category written by staff is kept", uploadedQ("second year")?.category === "Financial Readiness" && uploadedQ("come back")?.category === "Intent to Return");
  const bankAgain = await call("POST", "/api/admin/questions", { text: bankUpload });
  check("uploading the same list twice adds nothing", bankAgain.added?.length === 0 && bankAgain.duplicates === 6, JSON.stringify({ added: bankAgain.added?.length, duplicates: bankAgain.duplicates }));
  check("the bank reports built-in and uploaded counts", bankAgain.stats?.builtIn >= 20 && bankAgain.stats?.uploaded === 6, JSON.stringify(bankAgain.stats));

  token = other.token;
  const studentUpload = await call("POST", "/api/admin/questions", { text: "Why are you here today?" });
  check("students cannot upload questions", studentUpload.status === 404, String(studentUpload.status));
  token = adminLogin.token;

  const withBank = await call("POST", "/api/interviews", { mode: "strict" });
  check(
    "a staff-written wording is asked in place of the built-in one",
    withBank.question?.question === "What made you choose Texas State University of all places?",
    withBank.question?.question
  );
  const probed = await call("POST", `/api/interviews/${withBank.id}/answer`, {
    answer: "I chose it for the applied data-systems track, and my father has 55,000 dollars in savings for it.",
    seconds: 15,
  });
  check(
    "the officer follows up on a figure that is not in the file",
    /\$55,000/.test(probed.question?.question ?? "") && /\$40,000/.test(probed.question?.question ?? ""),
    probed.question?.question
  );

  const hobby = uploadedQ("hobby");
  const loanQ = uploadedQ("loan");
  const paused = await call("PATCH", `/api/admin/questions/${uploadedQ("{university}").id}`, { active: false });
  check("staff can switch a question off", paused.uploaded?.find((q) => q.question.includes("{university}"))?.active === false);
  const withoutIt = await call("POST", "/api/interviews", { mode: "neutral" });
  check("a switched-off question is no longer asked", withoutIt.question?.question === "Why did you choose Texas State University?", withoutIt.question?.question);
  const removed = await call("DELETE", `/api/admin/questions/${hobby.id}`);
  check("staff can delete a question", removed.stats?.uploaded === 5 && !removed.uploaded.some((q) => q.id === hobby.id));
  check("deleting twice is a clean 404", (await call("DELETE", `/api/admin/questions/${hobby.id}`)).status === 404);


  /* ------------------------------------------------ loading question files --- */
  section("Loading question files");
  const iv = await import("../backend/src/interviewer.mjs");

  // Preview: how a list would be read, with nothing saved.
  const previewText = [
    "ACADEMIC QUESTIONS",
    "1. What does your father do for a living?", // already in the bank from the upload above
    "Q2. Why don’t you study the same course in Nepal? Ans – Nepal does not offer it.",
    "Ans: Because the course is not offered at home.",
    "S.N.\tQuestion\tCategory",
    "3\tWhat if you can't find a job in Nepal?\tPressure",
    '4,"Why the USA, and not Canada?",Academic',
    "Why the USA, and not Canada?",
  ].join("\n");
  const bankBefore = (await call("GET", "/api/admin/questions")).stats.uploaded;
  const previewed = await call("POST", "/api/admin/questions/preview", { text: previewText });
  const previewQ = (words) => previewed.items?.find((q) => q.question.includes(words));
  check("preview reads the list without saving it", (await call("GET", "/api/admin/questions")).stats.uploaded === bankBefore, previewed.error);
  check("preview marks questions already in the bank", previewQ("father do")?.duplicate === "already in the bank", JSON.stringify(previewQ("father do")));
  check("preview marks a question repeated in the same list", previewed.items?.filter((q) => q.question === "Why the USA, and not Canada?").map((q) => q.duplicate).join("|") === "|repeated in this list");
  check(
    "numbering, curly quotes and an inline answer are cleaned off",
    previewQ("same course")?.question === "Why don't you study the same course in Nepal?",
    previewQ("same course")?.question
  );
  check("a heading files the questions under it", previewQ("same course")?.category === "Academic & Program");
  check("a spreadsheet row keeps just the question and its category", previewQ("find a job")?.question === "What if you can't find a job in Nepal?" && previewQ("find a job")?.category === "Composure Under Pressure", JSON.stringify(previewQ("find a job")));
  check("a CSV row with a comma inside the question stays whole", previewQ("and not Canada")?.question === "Why the USA, and not Canada?");
  check(
    "headings, answers and column titles are left out with a reason",
    ["heading", "an answer", "column headings"].every((reason) => previewed.skipped?.some((s) => s.reason.startsWith(reason))),
    JSON.stringify(previewed.skipped)
  );
  check("preview counts what would be added", previewed.counts?.new === 3 && previewed.counts?.duplicates === 2, JSON.stringify(previewed.counts));
  const nothingThere = await call("POST", "/api/admin/questions/preview", { text: "ok\nANSWERS:\nAns: yes" });
  check("a list with no questions gets a clear message", nothingThere.status === 400 && /No questions found/.test(nothingThere.error ?? ""), nothingThere.error);

  check(
    "'Why X over other universities?' is the why-this-university question",
    iv.classifyQuestion("Why did you choose {university} over other universities?").topic === "uni_choice"
  );
  check("'Why won't you stay in the USA?' is the will-you-stay question", iv.classifyQuestion("Why won't you stay in the USA?").topic === "think_stay");
  check(
    "a document title such as 'Question Bank' is not a Financial heading",
    iv.categoryFromLabel("NIEC F-1 Visa Question Bank") === null && iv.categoryFromLabel("Bank statement questions") === "Financial Readiness"
  );

  // The browser's file reader, run here on real Word and Excel files.
  const { readQuestionFile, decodeText } = await import("../frontend/file-text.mjs");
  const zlib = await import("node:zlib");
  const makeZip = (entries) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of Object.entries(entries)) {
      const data = Buffer.from(content, "utf8");
      const packed = zlib.deflateRawSync(data);
      const nameBytes = Buffer.from(name);
      const crc = zlib.crc32 ? zlib.crc32(data) : 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(packed.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, nameBytes, packed);
      centrals.push(central, nameBytes);
      offset += local.length + nameBytes.length + packed.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
  };

  const docx = makeZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": [
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      "<w:p><w:r><w:t>FINANCIAL QUESTIONS</w:t></w:r></w:p>",
      '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t xml:space="preserve">What does your mother </w:t></w:r><w:r><w:t>do for a living?</w:t></w:r></w:p>',
      "<w:p><w:r><w:t>Ans: She runs a shop.</w:t></w:r></w:p>",
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Why don&apos;t you study in Nepal &amp; stay home?</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Academic</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
      "</w:body></w:document>",
    ].join(""),
  });
  const fromWord = await readQuestionFile(new File([docx], "NIEC questions.docx"));
  const wordItems = iv.parseQuestionUpload(fromWord.text).items;
  check(
    "a Word file is read, runs joined, table rows kept together",
    wordItems.length === 2 &&
      wordItems[0].question === "What does your mother do for a living?" &&
      wordItems[0].category === "Financial Readiness" &&
      wordItems[1].question === "Why don't you study in Nepal & stay home?" &&
      wordItems[1].category === "Academic & Program",
    JSON.stringify(wordItems)
  );

  const xlsx = makeZip({
    "xl/sharedStrings.xml":
      "<sst><si><t>Question</t></si><si><t>Category</t></si><si><t>How much is your tuition?</t></si><si><t>Financial</t></si><si><r><t>What is your </t></r><r><t>IELTS score?</t></r></si></sst>",
    "xl/worksheets/sheet1.xml": [
      "<worksheet><sheetData>",
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>',
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Will you apply for OPT?</t></is></c></row>',
      '<row r="4"><c r="A4" s="1"/><c r="B4" t="s"><v>4</v></c></row>',
      "</sheetData></worksheet>",
    ].join(""),
  });
  const fromExcel = await readQuestionFile(new File([xlsx], "bank.xlsx"));
  const excelItems = iv.parseQuestionUpload(fromExcel.text).items;
  check(
    "an Excel file is read: shared text, inline text, rich text and empty cells",
    excelItems.map((q) => q.question).join(" | ") === "How much is your tuition? | Will you apply for OPT? | What is your IELTS score?" &&
      excelItems[0].category === "Financial Readiness",
    JSON.stringify(excelItems)
  );

  const windows = Buffer.from([...Buffer.from("What"), 0x92, ...Buffer.from("s your GPA?")]);
  check("an Excel-on-Windows CSV keeps its apostrophes", decodeText(windows) === "What’s your GPA?", decodeText(windows));
  check("a UTF-8 file's byte-order mark is removed", decodeText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("Why?")])) === "Why?");
  let pdfMessage = "";
  try {
    await readQuestionFile(new File([Buffer.from("%PDF-1.7")], "questions.pdf"));
  } catch (error) {
    pdfMessage = error.message;
  }
  check("a PDF gets a clear way forward instead of silence", /copy and paste/.test(pdfMessage), pdfMessage);
  let renamed = "";
  try {
    await readQuestionFile(new File([docx], "questions.txt"));
  } catch (error) {
    renamed = error.message;
  }
  check("a Word file saved with the wrong name is spotted", /rename it/i.test(renamed), renamed);

  /* --------------------------------------------- live question choice --- */
  section("Live question choice");
  const livePool = iv.buildPool([], profileInput);
  const liveRequired = iv.requiredTopicsFor(profileInput);
  check("a loan question is not in the pool when the file has no loan", !livePool.some((e) => e.topic === "loan"));
  check(
    "an uploaded loan question inherits that rule",
    !iv.buildPool([{ id: loanQ.id, question: loanQ.question, category: loanQ.category, topic: "loan" }], profileInput).some((e) => e.id === loanQ.id)
  );
  const opening = (answer) => [
    {
      position: 0,
      question: "Why did you choose Texas State University?",
      category: "Academic & Program",
      topic: "uni_choice",
      origin: "bank",
      isRequired: true,
      isFollowUp: false,
      answer,
      scores: { answer: 80, tone: 80, clarity: 80 },
    },
  ];
  const cousin = iv.planNext({
    rows: opening("I chose it for the data-systems track, and my cousin in Dallas studied there too."),
    profile: profileInput,
    mode: "neutral",
    requiredTopics: liveRequired,
    pool: livePool,
  }).pick;
  check("a relative in the U.S. mentioned in passing is followed up", cousin?.isFollowUp && /cousin/.test(cousin.question), cousin?.question);
  const helper = iv.planNext({
    rows: opening("I chose it for its data-systems track. My father pays, and my uncle might also help a little."),
    profile: profileInput,
    mode: "neutral",
    requiredTopics: liveRequired,
    pool: livePool,
  }).pick;
  check("a second person helping with money is followed up", helper?.isFollowUp && /uncle/.test(helper.question), helper?.question);
  const alreadySaid = [
    ...opening("I chose it for the applied data-systems track in its MS Computer Science programme."),
    {
      position: 1,
      question: "You mentioned your cousin in the United States. What is their status there, and will you live with them?",
      category: "Personal & History",
      topic: "uni_choice",
      origin: "hook:relative",
      isRequired: false,
      isFollowUp: true,
      answer: "He is a student there. My father is paying for my studies from his construction supply business.",
      scores: { answer: 80, tone: 80, clarity: 80 },
    },
  ];
  const deeper = iv.planNext({ rows: alreadySaid, profile: profileInput, mode: "casual", requiredTopics: liveRequired, pool: livePool, random: () => 0.99 }).pick;
  check(
    "a topic answered in passing is not asked again word for word",
    deeper?.topic === "sponsor" && deeper.required && !/who is sponsoring/i.test(deeper.question),
    JSON.stringify(deeper)
  );
  const plain = iv.planNext({
    rows: opening("I chose it for the applied data-systems track in its MS Computer Science programme and its analytics capstone course."),
    profile: profileInput,
    mode: "casual",
    requiredTopics: liveRequired,
    pool: livePool,
    random: () => 0.99, // an officer in no mood for small talk
  }).pick;
  check("a complete answer moves on to the next essential", plain && !plain.isFollowUp && plain.required, JSON.stringify(plain));
  const crowded = Array.from({ length: 8 }, (_, i) => ({
    position: i,
    question: `Earlier question number ${i}`,
    category: "Academic & Program",
    topic: i === 0 ? "uni_choice" : null,
    origin: "bank",
    isRequired: i === 0,
    isFollowUp: false,
    answer: "My cousin in Dallas has a green card, and we have 55,000 dollars.",
    scores: { answer: 80, tone: 80, clarity: 80 },
  }));
  const squeezed = iv.planNext({ rows: crowded, profile: profileInput, mode: "strict", requiredTopics: liveRequired, pool: livePool }).pick;
  check("a follow-up never squeezes out an essential topic", squeezed && !squeezed.isFollowUp && squeezed.required, JSON.stringify(squeezed));
  const variantPool = iv.buildPool(
    [
      { id: "v1", question: "Why this university?", category: "Academic & Program", topic: "uni_choice" },
      { id: "v2", question: "What made you pick {university}?", category: "Academic & Program", topic: "uni_choice" },
      { id: "v3", question: "Why did you apply to {university} and not somewhere else?", category: "Academic & Program", topic: "uni_choice" },
    ],
    profileInput
  );
  const openings = new Set(Array.from({ length: 60 }, () => iv.firstQuestion(variantPool).question));
  check("interviews open with different wordings from the bank", openings.size === 3, [...openings].join(" | "));

  /* ---------------------------------------------------- answer timing --- */
  section("Answer timing");

  const { scoreAnswer, spokenLength } = await import("../backend/src/ai.mjs");
  const slowTyped = {
    question: "Who is sponsoring your education?",
    category: "Financial",
    answer: "My father Ram Bahadur is sponsoring me. He runs a construction supply business in Kathmandu and his annual income covers my first-year cost of 34000 dollars.",
    seconds: 90, // about 18 words a minute: normal composing speed for a typist
  };
  const typed = scoreAnswer({ ...slowTyped, inputMode: "typed" });
  const voiced = scoreAnswer({ ...slowTyped, inputMode: "voice" });
  check("a slow typist is not penalised for pace", typed.tone > voiced.tone, `typed ${typed.tone} vs voice ${voiced.tone}`);
  check("a short answer is called short", spokenLength("Yes, my father.").verdict === "short");
  check("a rambling answer is called long", spokenLength("word ".repeat(140)).verdict === "long");
  check("a 60-word answer is a good length", spokenLength("word ".repeat(60)).verdict === "good");

  /* ------------------------------------------------ changing the data key --- */
  section("Changing the encryption key");
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const keyEnvFile = path.join(workDir, "rotate.env");
  writeFileSync(keyEnvFile, "# test\n");
  const rotateEnv = (extra = {}) => ({
    ...process.env,
    DATABASE_FILE: dbFile,
    LOG_DIR: path.join(workDir, "logs"),
    BACKUP_DIR: path.join(workDir, "backups"),
    ENV_FILE: keyEnvFile,
    PORT: String(PORT),
    DATA_ENCRYPTION_KEY: "e2e-encryption-key",
    ...extra,
  });
  const runRotate = (args, extra) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["scripts/rotate-key.mjs", ...args], { cwd: ROOT, env: rotateEnv(extra), encoding: "utf8" }) };
    } catch (error) {
      return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };

  check("the key cannot be changed while the server is running", /Stop it first/.test(runRotate([]).out));
  server.kill();
  await new Promise((resolve) => (server.exitCode !== null ? resolve() : server.once("exit", resolve)));

  const rotated = runRotate([]);
  check("the key change re-encrypts every field", rotated.code === 0 && /Re-encrypted \d+ field/.test(rotated.out), rotated.out);
  const newKey = readFileSync(keyEnvFile, "utf8").match(/^DATA_ENCRYPTION_KEY=(.+)$/m)?.[1] ?? "";
  check("the new key is saved to the settings file, and not printed", newKey.length >= 40 && !rotated.out.includes(newKey));
  check("the data reads with the new key", runRotate(["--check"], { DATA_ENCRYPTION_KEY: newKey }).code === 0);
  check("the old key no longer reads it", runRotate(["--check"]).code === 1);
  const { fieldCipher } = await import("../backend/src/security.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const rotatedDb = new DatabaseSync(dbFile, { readOnly: true });
  const universities = rotatedDb.prepare("SELECT us_university FROM profiles").all().map((r) => fieldCipher(newKey).decrypt(r.us_university));
  rotatedDb.close();
  check("student data is unchanged after the key change", universities.includes("Texas State University"), universities.join(", "));

  // The admin portal is its own app, served by the web server.
  const portalHtml = readFileSync(path.join(ROOT, "frontend", "admin", "index.html"), "utf8");
  check("the admin portal is a separate page that loads its own app", portalHtml.includes("/admin/admin.mjs") && portalHtml.includes("noindex"));
  const studentApp = readFileSync(path.join(ROOT, "frontend", "app.js"), "utf8");
  check("the student site no longer contains the admin screens", !/function viewAdmin|renderQuestionBank|staff-login/.test(studentApp));

  /* ------------------------------------------------------------ result --- */
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} checks passed, ${failed} failed.\n`);
  cleanup(failed === 0 ? 0 : 1);
} catch (error) {
  console.error("\nUnexpected error in the test run:", error);
  cleanup(1);
}
