import { ACCEPT, FileReadError, readQuestionFile } from "/file-text.mjs";
import {
  $,
  $$,
  THEME_KEY,
  createApi,
  esc,
  formatDate,
  formatDateTime,
  installPasswordReveal,
  meter,
  plural,
  resolveTheme,
  scoreClass,
  setBusy,
  toast,
} from "/shared.mjs";

/* =========================================================================
   NIEC Visa AI - admin portal (/admin/)

   A separate app for NIEC staff, with only staff features: usage overview,
   student accounts, the interview question bank, data requests and system
   health. It has its own sign-in and its own session, separate from the
   student site, and it never shows what a student wrote.
   ========================================================================= */

const TOKEN_KEY = "niec_admin_token";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  badges: { requests: 0, system: 0 },
};

const api = createApi({
  getToken: () => state.token,
  onUnauthorized: () => {
    setToken(null);
    renderLogin("Your session has ended. Please sign in again.");
  },
});

function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

const app = () => $("#adminApp");
const main = () => $("#adminMain");

/* --------------------------------- theme --------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private window - the choice just is not remembered */
  }
  applyTheme(next);
  renderShell();
  route();
}

/* -------------------------------- sign in -------------------------------- */

/**
 * Staff sign-in. A student account is refused with the same message as a
 * wrong password, so this page cannot be used to find out who is staff.
 */
function renderLogin(message = "") {
  state.user = null;
  app().innerHTML = `
    <main id="adminMain" class="shell staff-wrap" tabindex="-1">
      <div class="card staff-card">
        <div class="staff-mark">
          <img src="/assets/niec-logo-wordmark.png" alt="NIEC" width="120" height="38" />
          <span>Admin portal</span>
        </div>

        <h1 style="font-size:23px;margin-top:22px">Sign in</h1>
        <p style="margin-top:8px;color:var(--ink-soft);font-size:14.5px">
          For NIEC staff only. Student accounts cannot sign in here.
        </p>

        <form id="staffForm" style="margin-top:24px" novalidate>
          <div id="formError">${message ? `<div class="alert alert-warn">${esc(message)}</div>` : ""}</div>
          <div class="field-group">
            <label class="label" for="email">Work email</label>
            <input id="email" name="email" type="email" autocomplete="username" required placeholder="you@niec.edu.np" />
          </div>
          <div class="field-group">
            <label class="label" for="password">Password</label>
            <div class="password-wrap">
              <input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Your password" />
              <button type="button" class="reveal" data-for="password" aria-label="Show password">Show</button>
            </div>
          </div>
          <button class="btn btn-secondary btn-block btn-lg" type="submit">Sign in</button>
        </form>

        <p class="muted" style="margin-top:20px;line-height:1.7">
          Access is granted on the server by an existing administrator, never from a web page:
          <code>node scripts/make-admin.mjs you@niec.edu.np</code>
        </p>
      </div>
      <p style="margin-top:18px;text-align:center;font-size:14px"><a href="/">Go to the student site</a></p>
    </main>`;

  installPasswordReveal();
  $("#email").focus();

  $("#staffForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#staffForm button[type=submit]");
    setBusy(button, true, "Signing in...");
    try {
      const data = await api("/api/auth/staff-login", {
        method: "POST",
        body: { email: $("#email").value, password: $("#password").value },
      });
      setToken(data.token);
      await start();
    } catch (error) {
      $("#formError").innerHTML = `<div class="alert alert-error">${esc(error.message)}</div>`;
      setBusy(button, false);
    }
  });
}

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* the local session is cleared either way */
  }
  setToken(null);
  renderLogin();
  toast("Signed out.");
}

/* --------------------------------- shell --------------------------------- */

const PAGES = [
  { hash: "#/", label: "Overview", view: viewOverview },
  { hash: "#/students", label: "Students", view: viewStudents },
  { hash: "#/questions", label: "Question bank", view: viewQuestions },
  { hash: "#/requests", label: "Data requests", view: viewRequests, badge: () => state.badges.requests },
  { hash: "#/system", label: "System", view: viewSystem, badge: () => state.badges.system },
];

const currentPage = () => PAGES.find((p) => p.hash === (location.hash || "#/")) ?? PAGES[0];

function renderShell() {
  const page = currentPage();
  const dark = document.documentElement.dataset.theme === "dark";
  app().innerHTML = `
    <div class="admin-shell">
      <aside class="admin-side">
        <a class="admin-brand" href="#/" aria-label="Admin overview">
          <img src="/assets/niec-logo-wordmark.png" alt="NIEC" width="112" height="35" />
          <span>Admin</span>
        </a>
        <nav class="admin-nav" aria-label="Admin">
          ${PAGES.map((p) => {
            const count = p.badge?.() ?? 0;
            return `<a href="${p.hash}"${p === page ? ` aria-current="page"` : ""}>
              <span>${esc(p.label)}</span>${count ? `<span class="admin-badge">${count}</span>` : ""}
            </a>`;
          }).join("")}
        </nav>
        <div class="admin-side-foot">
          <div class="admin-user">
            <b>${esc(state.user.fullName)}</b>
            <span>${esc(state.user.email)}</span>
          </div>
          <div class="row" style="gap:8px">
            <button class="btn btn-ghost btn-sm" id="themeBtn" type="button">${dark ? "Light mode" : "Dark mode"}</button>
            <button class="btn btn-ghost btn-sm" id="signOutBtn" type="button">Sign out</button>
          </div>
          <a class="admin-site-link" href="/" target="_blank" rel="noopener">Open the student site ↗</a>
        </div>
      </aside>
      <main id="adminMain" class="admin-main" tabindex="-1"></main>
    </div>`;

  $("#signOutBtn").addEventListener("click", signOut);
  $("#themeBtn").addEventListener("click", toggleTheme);
}

/** Refresh the sidebar counts without re-rendering the page. */
function updateNav() {
  for (const link of $$(".admin-nav a")) {
    const page = PAGES.find((p) => p.hash === link.getAttribute("href"));
    if (page === currentPage()) {
      link.setAttribute("aria-current", "page");
      // On a phone the sections scroll sideways - keep the current one in view.
      link.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else {
      link.removeAttribute("aria-current");
    }
    const count = page?.badge?.() ?? 0;
    const badge = $(".admin-badge", link);
    if (count && badge) badge.textContent = count;
    else if (count) link.insertAdjacentHTML("beforeend", `<span class="admin-badge">${count}</span>`);
    else badge?.remove();
  }
}

async function route() {
  if (!state.user) return;
  updateNav();
  const page = currentPage();
  document.title = `${page.label} - NIEC Visa AI Admin`;
  main().innerHTML = `<p class="admin-loading">Loading...</p>`;
  try {
    await page.view();
  } catch (error) {
    // Admin endpoints answer 404 to anyone without admin rights - if that
    // happens here, the account lost its access mid-session.
    if (error.status === 404) {
      await start();
      return;
    }
    main().innerHTML = `<div class="admin-page"><div class="alert alert-error">${esc(error.message)}</div></div>`;
  }
  main().focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function pageHead(title, text) {
  return `<div class="page-head admin-head"><h1>${esc(title)}</h1>${text ? `<p>${text}</p>` : ""}</div>`;
}

/* -------------------------------- overview -------------------------------- */

async function viewOverview() {
  const [{ overview, engine, model }, { requests }, system, bank] = await Promise.all([
    api("/api/admin/overview"),
    api("/api/admin/data-requests"),
    api("/api/admin/system"),
    api("/api/admin/questions"),
  ]);
  const t = overview.totals;
  const open = requests.filter((r) => r.status !== "completed");
  state.badges.requests = open.length;
  state.badges.system = system.summary.fail;
  updateNav();

  // Things a member of staff should act on, most urgent first.
  const attention = [
    open.length && {
      tone: "warn",
      text: `${plural(open.length, "open data request")} - students have a legal right to a response.`,
      link: "#/requests",
      action: "Review",
    },
    system.summary.fail && {
      tone: "bad",
      text: `${plural(system.summary.fail, "launch blocker")} in the system check.`,
      link: "#/system",
      action: "See what",
    },
    system.errors.lastSevenDays && {
      tone: "warn",
      text: `${plural(system.errors.lastSevenDays, "server error")} in the last 7 days.`,
      link: "#/system",
      action: "Look",
    },
    !bank.stats.active && {
      tone: "info",
      text: "No questions uploaded yet - interviews use the 24 built-in topics only.",
      link: "#/questions",
      action: "Add questions",
    },
  ].filter(Boolean);

  main().innerHTML = `
    <div class="admin-page">
      ${pageHead("Overview", "How NIEC Visa AI is being used. Aggregates only - nothing a student wrote appears anywhere in this portal.")}

      <div class="card admin-attention">
        <h2 style="font-size:17px">Needs attention</h2>
        ${
          attention.length
            ? attention
                .map(
                  (a) => `<div class="list-row">
                    <span class="admin-dot admin-dot-${a.tone}" aria-hidden="true"></span>
                    <span style="flex:1">${esc(a.text)}</span>
                    <a class="btn btn-ghost btn-sm" href="${a.link}">${esc(a.action)}</a>
                  </div>`
                )
                .join("")
            : `<p class="muted" style="margin-top:8px">All clear - nothing needs you right now.</p>`
        }
      </div>

      <div class="grid grid-4" style="margin-top:18px">
        ${[
          ["Students", t.students, `${overview.recent.signups} new this week`],
          ["Interviews", t.interviews, `${overview.recent.interviews} this week`],
          ["Completed", t.completed, `${t.inProgress} in progress`],
          [
            "Average score",
            overview.scores.average ?? "-",
            overview.scores.average !== null ? `${overview.scores.lowest}-${overview.scores.highest} range` : "no data yet",
          ],
        ]
          .map(
            ([label, value, sub]) => `
          <div class="card stat-block">
            <span>${esc(label)}</span>
            <strong>${esc(String(value))}</strong>
            <div class="muted" style="margin-top:4px">${esc(sub)}</div>
          </div>`
          )
          .join("")}
      </div>

      <div class="grid grid-2" style="margin-top:18px">
        <div class="card">
          <h2 style="font-size:17px">Where students struggle</h2>
          <p class="muted" style="margin-top:4px">Average score per category, everyone combined. Worth teaching in person.</p>
          <div style="margin-top:16px">
            ${
              overview.categories.length
                ? overview.categories.map((c) => meter(c.category, c.average, `${plural(c.samples, "interview")}`)).join("")
                : `<p class="muted">No completed interviews yet.</p>`
            }
          </div>
        </div>

        <div class="card">
          <h2 style="font-size:17px">Verdicts and officers</h2>
          <div style="margin-top:14px">
            ${
              overview.verdicts.length
                ? overview.verdicts
                    .map((v) => `<div class="list-row" style="padding:10px 14px"><span>${esc(v.verdict)}</span><strong>${v.n}</strong></div>`)
                    .join("")
                : `<p class="muted">No verdicts yet.</p>`
            }
          </div>
          <div style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
            ${overview.modes
              .map((m) => `<div class="list-row" style="padding:10px 14px"><span>${esc(m.mode)} officer</span><strong>${m.n}</strong></div>`)
              .join("")}
          </div>
          <p class="muted" style="margin-top:14px">
            AI engine: <strong>${esc(engine)}</strong>${model ? ` (${esc(model)})` : ""} &middot;
            coach questions asked: ${t.coachQuestions}
          </p>
        </div>
      </div>
    </div>`;
}

/* -------------------------------- students -------------------------------- */

function studentRows(list) {
  if (!list.length) return `<tr><td colspan="6" class="muted">No accounts match.</td></tr>`;
  return list
    .map(
      (s) => `
    <tr>
      <td>
        <strong>${esc(s.fullName)}</strong>${s.role === "admin" ? ` <span class="pill pill-brand">admin</span>` : ""}
        <div class="muted">${esc(s.email)}</div>
      </td>
      <td>${formatDate(s.createdAt)}</td>
      <td>${s.completed} of ${s.interviews}</td>
      <td>${s.averageScore !== null ? `<span class="score-${scoreClass(s.averageScore)}">${s.averageScore}</span>` : "-"}</td>
      <td>${s.lastInterviewAt ? formatDate(s.lastInterviewAt) : "never"}</td>
      <td>${s.hasProfile ? "complete" : `<span class="muted">empty</span>`}</td>
    </tr>`
    )
    .join("");
}

async function viewStudents() {
  const { students } = await api("/api/admin/students");
  const active = students.filter((s) => s.interviews > 0).length;

  main().innerHTML = `
    <div class="admin-page">
      ${pageHead("Students", "Activity only - interviews taken and scores. Answers, profiles and financial details are never shown here.")}
      <div class="spread" style="margin-bottom:12px">
        <b>${plural(students.length, "account")} &middot; ${active} have practised</b>
        <input id="studentSearch" type="search" placeholder="Search by name or email..." style="max-width:300px" aria-label="Search students" />
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Joined</th><th>Interviews</th><th>Average</th><th>Last interview</th><th>Profile</th></tr></thead>
          <tbody id="studentRows">${studentRows(students)}</tbody>
        </table>
      </div>
    </div>`;

  $("#studentSearch").addEventListener("input", (event) => {
    const term = event.target.value.trim().toLowerCase();
    const list = term ? students.filter((s) => `${s.fullName} ${s.email}`.toLowerCase().includes(term)) : students;
    $("#studentRows").innerHTML = studentRows(list);
  });
}

/* ------------------------------ data requests ----------------------------- */

async function viewRequests() {
  const { requests } = await api("/api/admin/data-requests");
  const open = requests.filter((r) => r.status !== "completed");
  const done = requests.filter((r) => r.status === "completed");
  state.badges.requests = open.length;
  updateNav();

  const list = (items) =>
    items
      .map(
        (r) => `
      <div class="list-row">
        <div>
          <h3>${esc(r.kind === "access" ? "Data access" : "Account deletion")} &middot; ${esc(r.fullName)}</h3>
          <p class="muted">${esc(r.email)} &middot; requested ${formatDateTime(r.createdAt)}</p>
        </div>
        <div class="row">
          <span class="pill ${r.status === "completed" ? "pill-good" : "pill-warn"}">${esc(r.status)}</span>
          ${r.status !== "completed" ? `<button class="btn btn-ghost btn-sm complete-request" data-id="${esc(r.id)}" type="button">Mark done</button>` : ""}
        </div>
      </div>`
      )
      .join("");

  main().innerHTML = `
    <div class="admin-page">
      ${pageHead(
        "Data requests",
        "Students asking for a copy of their data, or for their account to be deleted. Deletion is not automatic - carry it out, then mark it done here."
      )}
      <h2 style="font-size:17px">Open (${open.length})</h2>
      <div style="margin-top:10px">${open.length ? list(open) : `<div class="card empty">No open requests.</div>`}</div>
      ${
        done.length
          ? `<details style="margin-top:24px"><summary class="muted" style="cursor:pointer">Done (${done.length})</summary>
               <div style="margin-top:10px">${list(done)}</div></details>`
          : ""
      }
    </div>`;

  for (const button of $$(".complete-request")) {
    button.addEventListener("click", async () => {
      setBusy(button, true, "Saving...");
      try {
        await api(`/api/admin/data-requests/${button.dataset.id}/complete`, { method: "POST" });
        toast("Marked done.", "success");
        await viewRequests();
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
  }
}

/* --------------------------------- system --------------------------------- */

const CHECK_PILL = {
  pass: `<span class="pill pill-good">ok</span>`,
  warn: `<span class="pill pill-warn">warning</span>`,
  fail: `<span class="pill pill-bad">blocker</span>`,
};

async function viewSystem() {
  const system = await api("/api/admin/system");
  state.badges.system = system.summary.fail;
  updateNav();

  const { summary, backups, errors, runtime } = system;
  const groups = [...new Set(system.checks.map((c) => c.group))];
  const backupAge = backups
    ? backups.ageHours < 1
      ? "under an hour ago"
      : backups.ageHours < 48
        ? `${Math.round(backups.ageHours)} hours ago`
        : `${Math.round(backups.ageHours / 24)} days ago`
    : null;

  main().innerHTML = `
    <div class="admin-page">
      ${pageHead("System", "Launch readiness, backups and errors. The same checks as <code>node scripts/preflight.mjs</code> on the server.")}

      <div class="alert ${summary.fail ? "alert-error" : summary.warn ? "alert-warn" : "alert-good"}">
        ${
          summary.fail
            ? `<b>Not ready to launch:</b> ${plural(summary.fail, "blocker")} and ${plural(summary.warn, "warning")} below.`
            : summary.warn
              ? `<b>No blockers.</b> ${plural(summary.warn, "warning")} to read before launch.`
              : `<b>All checks passed.</b> Ready to launch.`
        }
      </div>

      <div class="grid grid-2" style="margin-top:6px">
        <div class="card">
          <h2 style="font-size:17px">Launch readiness</h2>
          ${groups
            .map(
              (group) => `
            <h3 class="admin-check-group">${esc(group)}</h3>
            ${system.checks
              .filter((c) => c.group === group)
              .map(
                (c) => `<div class="admin-check">
                  ${CHECK_PILL[c.status]}
                  <div><b>${esc(c.label)}</b>${c.detail ? `<p class="muted">${esc(c.detail)}</p>` : ""}</div>
                </div>`
              )
              .join("")}`
            )
            .join("")}
        </div>

        <div>
          <div class="card">
            <h2 style="font-size:17px">Server</h2>
            <div style="margin-top:10px">
              ${[
                ["AI engine", runtime.engine === "provider" ? `AI provider (${runtime.model})` : "built-in (no AI key)"],
                ["Mode", runtime.env],
                ["Running for", `${runtime.uptimeHours} hours`],
                ["Node.js", runtime.node],
              ]
                .map(([k, v]) => `<div class="list-row" style="padding:9px 14px"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`)
                .join("")}
            </div>
          </div>

          <div class="card" style="margin-top:18px">
            <h2 style="font-size:17px">Backups</h2>
            <p style="margin-top:8px;font-size:14.5px">
              ${
                backups
                  ? `${plural(backups.count, "backup")} kept. Newest taken ${esc(backupAge)}.`
                  : "No backups taken yet."
              }
            </p>
            <p class="muted" style="margin-top:6px">On the server a backup runs every night. By hand: <code>node scripts/backup.mjs</code></p>
          </div>

          <div class="card" style="margin-top:18px">
            <h2 style="font-size:17px">Server errors, last 7 days</h2>
            ${
              errors.latest.length
                ? `<p class="muted" style="margin-top:6px">${plural(errors.lastSevenDays, "error")}. A student who saw an error has a reference code - find it here, or run <code>node scripts/logs.mjs --errors</code> for the full detail.</p>
                   <ul class="unasked-list" style="margin-top:10px">
                     ${errors.latest
                       .slice(0, 8)
                       .map(
                         (e) =>
                           `<li><span class="muted">${formatDateTime(e.time)}${e.reference ? ` &middot; ref ${esc(e.reference)}` : ""}</span><br />${esc(e.error || e.message)}</li>`
                       )
                       .join("")}
                   </ul>`
                : `<p class="muted" style="margin-top:8px">None. Everything is running cleanly.</p>`
            }
          </div>

          <div class="card" style="margin-top:18px">
            <h2 style="font-size:17px">Staff accounts</h2>
            <p class="muted" style="margin-top:8px;line-height:1.7">
              Admin rights are given on the server, never from a web page, so a stolen session cannot promote itself.
              The person must first create a normal account, then:<br />
              <code>node scripts/make-admin.mjs name@niec.edu.np</code><br />
              Remove with <code>--remove</code>, list with <code>--list</code>.
            </p>
          </div>
        </div>
      </div>
    </div>`;
}

/* ------------------------------ question bank ----------------------------- */

const TOPIC_LABELS = {
  uni_choice: "Why this university",
  program_content: "Programme",
  why_not_home: "Why not at home",
  shortlist: "Other universities",
  academics: "Grades",
  english: "English test",
  gap: "Gap years",
  sponsor: "Sponsor",
  first_year_cost: "Cost",
  shortfall: "Funding gap",
  loan: "Loan",
  work: "Working while studying",
  after_graduation: "Plans after",
  salary: "Salary",
  opt: "OPT",
  ties: "Ties to home",
  relatives: "Relatives in the U.S.",
  refusal: "Past refusal",
  travel: "Travel",
  who_chose: "Who helped",
  why_visa: "Why a visa",
  think_stay: "Will you stay",
  no_job: "No job",
  rehearsed: "Rehearsed answers",
};
const topicLabel = (topic) => (topic ? TOPIC_LABELS[topic] ?? topic : "general");

function bankRows(list) {
  if (!list.length) return `<tr><td colspan="5" class="muted">No questions match.</td></tr>`;
  return list
    .map(
      (q) => `
    <tr${q.active ? "" : ` class="bank-off"`}>
      <td>${esc(q.question)}</td>
      <td>${esc(q.category)}</td>
      <td><span class="pill pill-brand">${esc(topicLabel(q.topic))}</span></td>
      <td>
        <label class="checkbox" style="margin:0">
          <input type="checkbox" class="bank-active" data-id="${esc(q.id)}" ${q.active ? "checked" : ""} />
          <span>${q.active ? "asked" : "off"}</span>
        </label>
      </td>
      <td><button class="btn btn-ghost btn-sm bank-delete" data-id="${esc(q.id)}" type="button">Delete</button></td>
    </tr>`
    )
    .join("");
}

async function viewQuestions() {
  main().innerHTML = `<div class="admin-page" id="bankSection"></div>`;
  renderQuestionBank(await api("/api/admin/questions"));
}

function renderQuestionBank(bank, lastUpload = null) {
  const section = $("#bankSection");
  if (!section) return;
  const s = bank.stats;
  section.innerHTML = `
    ${pageHead(
      "Question bank",
      `The officer chooses every question live, after hearing the answer before it, from this bank: ${s.builtIn} built-in
       topics plus the ${plural(s.active, "active question")} you have added. Each question you add is sorted into a topic
       automatically, so "What does your father do?" counts as the sponsor question and is asked in its place.`
    )}

    <div class="grid grid-2">
      <div class="card bank-drop" id="bankDrop">
        <h2 style="font-size:17px">Add questions</h2>
        <p class="muted" style="margin-top:6px;line-height:1.6">
          Load a <b>Word</b> (.docx), <b>Excel</b> (.xlsx), <b>CSV</b> or <b>text</b> file - or drop it here, or paste.
          Numbering, headings, column titles and sample answers are recognised and left out; a heading such as
          "Financial questions" files the questions under it. <code>{university}</code>, <code>{program}</code> and
          <code>{homeCountry}</code> are filled from each student's file. You see everything before it is saved.
        </p>
        <textarea id="bankText" rows="8" style="margin-top:12px" aria-label="Questions, one per line"
          placeholder="Why did you choose {university}?&#10;What does your father do for a living?&#10;Financial | How will you pay for your second year?"></textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn btn-primary" id="bankPreview" type="button">Check questions</button>
          <label class="btn btn-ghost" style="cursor:pointer">
            Load files<input type="file" id="bankFile" accept="${ACCEPT}" multiple hidden />
          </label>
          <span class="muted" id="bankFileNote" aria-live="polite"></span>
        </div>
        ${
          lastUpload
            ? `<div class="alert alert-good" style="margin:14px 0 0">
                 Added <b>${lastUpload.added.length}</b> question${lastUpload.added.length === 1 ? "" : "s"}${
                   lastUpload.duplicates ? ` &middot; ${lastUpload.duplicates} already in the bank, not added again` : ""
                 }. New interviews use them straight away.
               </div>`
            : ""
        }
      </div>

      <div class="card">
        <h2 style="font-size:17px">Your questions by category</h2>
        <div style="margin-top:12px">
          ${s.byCategory
            .map((c) => `<div class="list-row" style="padding:10px 14px"><span>${esc(c.category)}</span><strong>${c.count}</strong></div>`)
            .join("")}
        </div>
        <details style="margin-top:14px">
          <summary class="muted" style="cursor:pointer">Built-in topics (${bank.builtIn.length})</summary>
          <ul class="unasked-list" style="margin-top:10px">
            ${bank.builtIn
              .map(
                (b) =>
                  `<li><span class="pill pill-brand">${esc(topicLabel(b.topic))}</span> ${esc(b.question)}${
                    b.conditional ? ` <span class="muted">(only when the student's file has it)</span>` : ""
                  }</li>`
              )
              .join("")}
          </ul>
        </details>
      </div>
    </div>

    <div id="bankPreviewSlot"></div>

    ${
      bank.uploaded.length
        ? `<div class="spread" style="margin-top:22px">
             <b>${plural(bank.uploaded.length, "question")} added by staff</b>
             <input id="bankSearch" type="search" placeholder="Search questions..." style="max-width:280px" aria-label="Search questions" />
           </div>
           <div class="table-scroll" style="margin-top:10px">
             <table class="data-table">
               <thead><tr><th>Question</th><th>Category</th><th>Topic</th><th>Status</th><th></th></tr></thead>
               <tbody id="bankRows">${bankRows(bank.uploaded)}</tbody>
             </table>
           </div>`
        : `<div class="card empty" style="margin-top:18px">No questions added yet - the officer is using the built-in topics only.</div>`
    }`;

  const bindRows = () => {
    for (const box of $$(".bank-active")) {
      box.addEventListener("change", async () => {
        try {
          renderQuestionBank(await api(`/api/admin/questions/${box.dataset.id}`, { method: "PATCH", body: { active: box.checked } }));
        } catch (error) {
          box.checked = !box.checked;
          toast(error.message, "error");
        }
      });
    }
    for (const button of $$(".bank-delete")) {
      button.addEventListener("click", async () => {
        if (!window.confirm("Delete this question from the bank? Past interviews keep it; new ones will not ask it.")) return;
        try {
          renderQuestionBank(await api(`/api/admin/questions/${button.dataset.id}`, { method: "DELETE" }));
          toast("Question deleted.", "success");
        } catch (error) {
          toast(error.message, "error");
        }
      });
    }
  };
  bindRows();

  $("#bankSearch")?.addEventListener("input", (event) => {
    const term = event.target.value.trim().toLowerCase();
    const list = term
      ? bank.uploaded.filter((q) => `${q.question} ${q.category} ${topicLabel(q.topic)}`.toLowerCase().includes(term))
      : bank.uploaded;
    $("#bankRows").innerHTML = bankRows(list);
    bindRows();
  });

  const textBox = $("#bankText");
  const note = $("#bankFileNote");
  const slot = $("#bankPreviewSlot");

  // Editing the list invalidates the preview: what is added is always what was checked.
  textBox.addEventListener("input", () => {
    slot.innerHTML = "";
  });

  const loadFiles = async (files) => {
    if (!files.length) return;
    note.textContent = `Reading ${files.length === 1 ? files[0].name : `${files.length} files`}...`;
    const texts = [];
    const problems = [];
    let lines = 0;
    for (const file of files) {
      try {
        const result = await readQuestionFile(file);
        texts.push(result.text);
        lines += result.lines;
      } catch (error) {
        problems.push(error instanceof FileReadError ? error.message : `${file.name} could not be read.`);
      }
    }
    for (const problem of problems) toast(problem, "error");
    if (!texts.length) {
      note.textContent = "";
      return;
    }
    const read = files.length - problems.length;
    textBox.value = [textBox.value.trim(), ...texts].filter(Boolean).join("\n");
    note.textContent = `${plural(lines, "line")} read from ${plural(read, "file")}.`;
    await preview();
  };

  $("#bankFile").addEventListener("change", async (event) => {
    await loadFiles([...(event.target.files ?? [])]);
    event.target.value = ""; // choosing the same file again still triggers a load
  });

  const drop = $("#bankDrop");
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add("bank-drop-over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, () => drop.classList.remove("bank-drop-over"));
  }
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    void loadFiles([...(event.dataTransfer?.files ?? [])]);
  });

  /** Show how the list will be read: nothing is saved until "Add". */
  const preview = async () => {
    const text = textBox.value;
    if (!text.trim()) {
      toast("Paste some questions or load a file first.", "error");
      return;
    }
    const button = $("#bankPreview");
    setBusy(button, true, "Checking...");
    try {
      renderPreview(await api("/api/admin/questions/preview", { method: "POST", body: { text } }), text);
    } catch (error) {
      slot.innerHTML = "";
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  };
  $("#bankPreview").addEventListener("click", preview);

  const renderPreview = ({ items, skipped, counts }, text) => {
    const shown = items.slice(0, 300);
    slot.innerHTML = `
      <div class="card bank-preview" style="margin-top:18px">
        <div class="spread">
          <div>
            <h2 style="font-size:17px">Check before adding</h2>
            <p class="muted" style="margin-top:4px">
              <b>${plural(counts.new, "new question")}</b>${counts.duplicates ? ` &middot; ${counts.duplicates} already in the bank` : ""}${
                counts.skipped ? ` &middot; ${plural(counts.skipped, "line")} left out` : ""
              }. If a category or topic looks wrong, edit the list above and check again.
            </p>
          </div>
          <div class="row">
            <button class="btn btn-primary" id="bankAdd" type="button"${counts.new ? "" : " disabled"}>
              ${counts.new ? `Add ${plural(counts.new, "question")}` : "Nothing new to add"}
            </button>
            <button class="btn btn-ghost" id="bankCancel" type="button">Cancel</button>
          </div>
        </div>
        <div class="table-scroll" style="margin-top:12px">
          <table class="data-table">
            <thead><tr><th>Question</th><th>Category</th><th>Topic</th><th></th></tr></thead>
            <tbody>
              ${shown
                .map(
                  (q) => `<tr${q.duplicate ? ` class="bank-off"` : ""}>
                    <td>${esc(q.question)}</td>
                    <td>${esc(q.category)}</td>
                    <td><span class="pill pill-brand">${esc(topicLabel(q.topic))}</span></td>
                    <td>${q.duplicate ? `<span class="muted">${esc(q.duplicate)}</span>` : `<span class="pill pill-good">new</span>`}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
        ${items.length > shown.length ? `<p class="muted" style="margin-top:8px">Showing the first ${shown.length} of ${items.length}.</p>` : ""}
        ${
          skipped.length
            ? `<details style="margin-top:12px">
                 <summary class="muted" style="cursor:pointer">${plural(skipped.length, "line")} left out, and why</summary>
                 <ul class="unasked-list" style="margin-top:10px">
                   ${skipped.map((line) => `<li><span class="muted">${esc(line.reason)}:</span> ${esc(line.line)}</li>`).join("")}
                 </ul>
               </details>`
            : ""
        }
      </div>`;

    $("#bankCancel").addEventListener("click", () => {
      slot.innerHTML = "";
    });
    $("#bankAdd").addEventListener("click", async () => {
      const button = $("#bankAdd");
      setBusy(button, true, "Adding...");
      try {
        const added = await api("/api/admin/questions", { method: "POST", body: { text } });
        renderQuestionBank(added, added);
        toast(`Added ${plural(added.added.length, "question")}.`, "success");
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
    slot.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

/* ---------------------------------- boot ---------------------------------- */

/** Check the stored session belongs to an admin, then open the portal. */
async function start() {
  if (!state.token) {
    renderLogin();
    return;
  }
  let me;
  try {
    me = await api("/api/me");
  } catch {
    setToken(null);
    renderLogin();
    return;
  }
  if (me.user?.role !== "admin") {
    setToken(null);
    renderLogin("That account does not have staff access.");
    return;
  }
  state.user = me.user;

  // Sidebar counts: open data requests and launch blockers.
  try {
    const [{ requests }, system] = await Promise.all([api("/api/admin/data-requests"), api("/api/admin/system")]);
    state.badges.requests = requests.filter((r) => r.status !== "completed").length;
    state.badges.system = system.summary.fail;
  } catch {
    /* counts are a nicety; the pages load them again */
  }
  renderShell();
  await route();
}

let storedTheme = "light";
try {
  storedTheme = localStorage.getItem(THEME_KEY) || "light";
} catch {
  /* private window */
}
applyTheme(storedTheme);
window.addEventListener("hashchange", route);
void start();
