/* =========================================================================
   NIEC Visa AI - frontend application
   Vanilla ES modules, no build step and no framework.

   Layout of this file:
     1.  config, state and the API client
     2.  small helpers (escaping, toasts, score formatting, meters)
     3.  theme and chrome (header, nav, notifications badge)
     4.  content (profile field definitions, resource library)
     5.  views, one function per screen
     6.  the interview runtime (voice in, voice out, scoring)
     7.  router and boot
   ========================================================================= */

/* ------------------------------------------------------------------ 1. api */

const API_BASE = (window.NIEC_CONFIG && typeof window.NIEC_CONFIG.apiBaseUrl === "string") ? window.NIEC_CONFIG.apiBaseUrl : "http://localhost:4000";
const TOKEN_KEY = "niec_token";
const THEME_KEY = "niec_theme";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  profile: null,
  completeness: 0,
  preferences: { theme: "light", marketingOptIn: false, productEmails: true },
  unread: 0,
  serverConfig: null,
  interview: null, // live interview runtime
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Cannot reach the NIEC Visa AI server. Is the backend running?", 0);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.token) signOutLocally();
    throw new ApiError(payload.error || "Something went wrong.", response.status);
  }
  return payload;
}

function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function signOutLocally() {
  setToken(null);
  state.user = null;
  state.profile = null;
  state.unread = 0;
  renderChrome();
}

async function loadSession() {
  if (!state.token) return null;
  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.profile = data.profile;
    state.completeness = data.completeness;
    state.preferences = data.preferences;
    state.unread = data.unreadNotifications;
    applyTheme(state.preferences.theme, { persist: false });
    return data;
  } catch {
    signOutLocally();
    return null;
  }
}

/* -------------------------------------------------------------- 2. helpers */

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/** Escape anything that came from a user or the API before putting it in HTML. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(message, kind = "") {
  const stack = $("#toastStack");
  const node = document.createElement("div");
  node.className = `toast ${kind}`.trim();
  node.textContent = message;
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

const scoreClass = (value) => (value >= 75 ? "good" : value >= 60 ? "warn" : "bad");

function meter(label, value, sub = "") {
  const tone = scoreClass(value);
  return `
    <div class="meter">
      <div class="meter-head"><span>${esc(label)}</span><b class="score-${tone}">${value}</b></div>
      <div class="meter-track"><div class="meter-fill fill-${tone}" style="width:${Math.max(2, value)}%"></div></div>
      ${sub ? `<div class="meter-sub">${esc(sub)}</div>` : ""}
    </div>`;
}

function ring(value, caption = "score") {
  const size = 148;
  const stroke = 11;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, value)) / 100) * circumference;
  const tone = scoreClass(value);
  const colors = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)" };
  return `
    <div class="ring-wrap">
      <svg width="${size}" height="${size}" aria-hidden="true">
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="var(--line)" stroke-width="${stroke}"></circle>
        ${
          value > 0
            ? `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${colors[tone]}" stroke-width="${stroke}"
                 stroke-linecap="round" stroke-dasharray="${dash} ${circumference}"></circle>`
            : "" /* a round cap on a zero-length arc renders as a stray dot */
        }
      </svg>
      <div class="ring-value"><strong class="score-${tone}">${value}</strong><span>${esc(caption)}</span></div>
    </div>`;
}

function sparkline(points) {
  if (!points || points.length < 2) return "";
  const width = 260;
  const height = 60;
  const max = Math.max(...points, 100);
  const min = Math.min(...points, 0);
  const range = Math.max(max - min, 1);
  const coords = points.map((p, i) => [
    (i / (points.length - 1)) * width,
    height - ((p - min) / range) * height,
  ]);
  const path = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const dots = coords
    .map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === coords.length - 1 ? 4.5 : 2.5}"
      fill="${i === coords.length - 1 ? "var(--accent)" : "var(--brand)"}"></circle>`)
    .join("");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Score history">
    <path d="${path}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    ${dots}
  </svg>`;
}

function verdictPill(verdict) {
  const map = {
    "Likely approved": "pill-good",
    Borderline: "pill-warn",
    "Likely refused": "pill-bad",
  };
  return `<span class="pill ${map[verdict] || "pill-warn"}">${esc(verdict)}</span>`;
}

function severityPill(severity) {
  const map = { high: "pill-bad", medium: "pill-warn", low: "pill-brand" };
  return `<span class="pill ${map[severity] || "pill-brand"}">${esc(severity)} risk</span>`;
}

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : "";

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

function setBusy(button, busy, busyLabel = "Working...") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

/* --------------------------------------------------- 3. theme and chrome */

function applyTheme(theme, { persist = true } = {}) {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.dataset.theme = resolved;
  $("#themeIcon").textContent = resolved === "dark" ? "☀" : "☾";
  if (persist) localStorage.setItem(THEME_KEY, theme);
}

async function toggleTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  state.preferences.theme = next;
  if (state.token) {
    try {
      await api("/api/preferences", { method: "PUT", body: { theme: next } });
    } catch {
      /* appearance is not worth interrupting the user for */
    }
  }
}

const NAV_SIGNED_OUT = [
  ["#/#how", "How it works"],
  ["#/#features", "Features"],
  ["#/resources", "Resources"],
  ["#/#faq", "FAQ"],
];

const NAV_SIGNED_IN = [
  ["#/dashboard", "Dashboard"],
  ["#/interview", "Mock interview"],
  ["#/coach", "Ask a question"],
  ["#/analytics", "Progress"],
  ["#/resources", "Resources"],
];

function renderChrome() {
  const signedIn = Boolean(state.user);
  const links = signedIn ? NAV_SIGNED_IN : NAV_SIGNED_OUT;
  const current = location.hash || "#/";

  const linkHtml = links
    .map(
      ([href, label]) =>
        `<a href="${href}"${current.startsWith(href) && href !== "#/" ? ' aria-current="page"' : ""}>${esc(label)}</a>`
    )
    .join("");

  $("#mainNav").innerHTML = linkHtml;
  $("#headerAuth").innerHTML = signedIn
    ? `<span class="user-chip">${esc(state.user.fullName.split(" ")[0])}</span>
       <a class="btn btn-ghost btn-sm" href="#/settings">Settings</a>
       <button class="btn btn-primary btn-sm" id="signOutBtn" type="button">Sign out</button>`
    : `<a class="btn btn-ghost btn-sm" href="#/login">Sign in</a>
       <a class="btn btn-primary btn-sm" href="#/signup">Practise free</a>`;

  $("#mobileNav").innerHTML =
    linkHtml +
    (signedIn
      ? `<a href="#/settings">Settings</a><a href="#/notifications">Notifications</a><a href="#" id="signOutMobile">Sign out</a>`
      : `<a href="#/login">Sign in</a><a href="#/signup">Create account</a>`);

  $("#bellLink").hidden = !signedIn;
  const badge = $("#unreadBadge");
  badge.hidden = !signedIn || state.unread === 0;
  badge.textContent = String(state.unread);

  $("#signOutBtn")?.addEventListener("click", signOut);
  $("#signOutMobile")?.addEventListener("click", (event) => {
    event.preventDefault();
    signOut();
  });
}

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* the local session is cleared either way */
  }
  signOutLocally();
  toast("Signed out.");
  location.hash = "#/";
}

function closeMobileNav() {
  const nav = $("#mobileNav");
  nav.dataset.open = "false";
  nav.hidden = true;
  $("#menuToggle").setAttribute("aria-expanded", "false");
}

/* ------------------------------------------------------------- 4. content */

/** The applicant file. Mirrors PROFILE_FIELDS on the server. */
const PROFILE_STEPS = [
  {
    id: "personal",
    title: "About you",
    intro: "The basics an officer confirms in the first ten seconds.",
    fields: [
      ["fullName", "Full name", "As printed on your passport"],
      ["homeCountry", "Home country", "Nepal"],
      ["homeCity", "Home city", "Kathmandu"],
      ["age", "Age", "22"],
    ],
  },
  {
    id: "academic",
    title: "Academic background",
    intro: "What you have already studied, and how well.",
    fields: [
      ["highestDegree", "Highest qualification", "Bachelor of Science"],
      ["previousMajor", "Field of study", "Computer Science"],
      ["previousInstitution", "Institution", "Tribhuvan University"],
      ["gpa", "GPA or percentage", "3.4 / 4.0"],
      ["graduationYear", "Graduation year", "2025"],
      ["englishTest", "English test and score", "IELTS 7.0"],
      ["gapYears", "Gap since graduation", "1 year (leave blank if none)"],
    ],
  },
  {
    id: "study",
    title: "Your U.S. study plan",
    intro: "Copy these from your I-20 so every number matches your documents.",
    fields: [
      ["usUniversity", "University", "Texas State University"],
      ["program", "Programme", "MS in Computer Science"],
      ["degreeLevel", "Degree level", "Master's"],
      ["usCity", "City and state", "San Marcos, Texas"],
      ["startTerm", "Start term", "Fall 2026"],
      ["programMonths", "Programme length in months", "24"],
      ["tuitionUsd", "Annual tuition (USD)", "18500"],
      ["totalCoaUsd", "First-year cost of attendance (USD)", "34000"],
    ],
  },
  {
    id: "finance",
    title: "How it is funded",
    intro: "Vague money answers are the most common reason students are refused.",
    fields: [
      ["sponsorName", "Sponsor name", "Ram Bahadur Budhathoki"],
      ["sponsorRelation", "Relationship to you", "Father"],
      ["sponsorOccupation", "Sponsor occupation", "Owner, construction supply business"],
      ["annualIncomeUsd", "Sponsor annual income (USD)", "22000"],
      ["savingsUsd", "Documented savings (USD)", "40000"],
      ["loanUsd", "Sanctioned education loan (USD)", "0"],
      ["scholarshipUsd", "Scholarship or assistantship (USD)", "6000"],
    ],
  },
  {
    id: "intent",
    title: "Career and intent",
    intro: "This is where an F-1 interview is won or lost.",
    fields: [
      ["whyUsa", "Why the United States?", "The specialisation I need is not offered at home because...", true],
      ["whyProgram", "Why this programme and university?", "The data-systems track and the analytics capstone...", true],
      ["careerGoal", "Career goal", "Data engineer in Nepal's fintech sector"],
      ["planAfter", "Plan right after graduation", "Return to Kathmandu and join...", true],
      ["tiesHome", "Ties to home", "Family business, property, dependents", true],
    ],
  },
  {
    id: "history",
    title: "Visa history",
    intro: "Everything here is verifiable. Record it honestly - concealment is worse than the fact.",
    fields: [
      ["previousApplications", "Previous U.S. applications", "1 (F-1, 2025)"],
      ["refusals", "Previous refusals", "No"],
      ["refusalReason", "Reason given, if refused", "214(b) - ties to home country"],
      ["relativesInUs", "Relatives in the U.S.", "Uncle, permanent resident, Texas"],
      ["travelHistory", "Travel history", "India 2023, UAE 2024"],
    ],
  },
];

const PROFILE_KEYS = PROFILE_STEPS.flatMap((step) => step.fields.map(([key]) => key));

/** The educational resource library. */
const RESOURCES = [
  {
    slug: "student-visa-guide",
    category: "Student visa",
    minutes: 9,
    title: "The F-1 student visa interview, start to finish",
    excerpt: "What the interview is, what the officer decides, and the three things every question is really testing.",
    sections: [
      {
        h: "It is shorter than you expect",
        p: [
          "Most F-1 interviews last two to four minutes. You will answer somewhere between five and ten questions through a glass window, often while the officer is reading your file rather than looking at you.",
          "That length is the whole problem. There is no time to recover from a weak opening and no second chance to explain what you meant. Each answer has to land the first time.",
        ],
      },
      {
        h: "Every question tests one of three things",
        ul: [
          "Are you a genuine student? Do you know your programme, and can you handle it academically?",
          "Is the money real? Is it documented, sufficient, and does it come from where you say it does?",
          "Will you leave? Is there a specific reason for you to return home when the degree ends?",
        ],
        p: ["Once you can hear which of the three a question is probing, unfamiliar wording stops being frightening."],
      },
      {
        h: "The shape of a strong answer",
        p: [
          "Answer in three or four sentences. Lead with the direct answer, add one verifiable fact, then stop. Silence after a complete answer is fine - filling it is how students talk themselves into a refusal.",
          "One fact per sentence is the useful discipline: a course name, a figure, a date, a role. Facts are checkable, and checkable answers are what get approved.",
        ],
      },
      {
        h: "Follow-ups are the real test",
        p: [
          "The first question is rarely the hard one. 'Why this university?' is easy. 'Which two courses in that programme?' is where a rehearsed applicant runs out of material.",
          "Practise the second and third layer of every answer. If your answer mentions a lab, know what that lab works on. If it mentions a scholarship, know the amount and the condition attached to it.",
        ],
      },
    ],
  },
  {
    slug: "interview-tips",
    category: "Preparation",
    minutes: 6,
    title: "Twelve interview tips that actually change the outcome",
    excerpt: "Practical habits for the queue, the window, and the ninety seconds that decide it.",
    sections: [
      {
        h: "Before you go in",
        ul: [
          "Know your I-20 numbers by heart: programme length, tuition, and total cost of attendance.",
          "Re-read your DS-160 the night before. Your spoken answers must match what you filed.",
          "Sort documents in the order you will be asked for them: passport, I-20, DS-160 confirmation, SEVIS receipt, financials.",
          "Sleep. A tired applicant hedges, and hedging reads as doubt.",
        ],
      },
      {
        h: "At the window",
        ul: [
          "Greet the officer, then let them lead. Do not open with a speech.",
          "Answer in English, even if you are nervous. Asking to switch languages raises a question you do not want asked.",
          "Three or four sentences per answer, then stop talking.",
          "If you do not know something, say so briefly. 'I do not know the exact figure, but the total on my I-20 is $34,000' beats a number you invented.",
          "Do not argue, and never mention a previous officer being unfair.",
        ],
      },
      {
        h: "Things that quietly help",
        ul: [
          "Say the word 'return' out loud at least once, attached to something concrete.",
          "Name your sponsor's occupation, not just their relationship to you.",
          "Have one specific detail about your programme that is not on any website - something you learned from a course catalogue or an email from the department.",
        ],
      },
    ],
  },
  {
    slug: "common-mistakes",
    category: "Mistakes",
    minutes: 8,
    title: "Nine mistakes that refuse students who deserved a visa",
    excerpt: "Refusals are rarely caused by the facts. They are caused by vague answers, changed stories, and one sentence that sounds like you plan to stay.",
    sections: [
      {
        h: "1. The memorised answer",
        p: [
          "Officers interview hundreds of applicants a week from the same cities and the same consultancies. A shared script is obvious, and a rehearsed delivery makes them wonder what else was prepared for them. Prepare the facts, not the sentences.",
        ],
      },
      {
        h: "2. Money answers with no numbers",
        p: [
          "'My father will pay' is not an answer. The officer needs an occupation, an income, and confirmation that funds are already in an account with a history. If you do not know your sponsor's annual income, you are not ready.",
        ],
      },
      {
        h: "3. A story that changes",
        p: [
          "Your DS-160, your I-20 and your spoken answers must agree. A sponsor who is your father on the form and your uncle at the window is a refusal, even when both are genuinely contributing.",
        ],
      },
      {
        h: "4. Sentences that sound like immigration",
        ul: [
          "'Opportunities are better there' - said about the U.S., this is intent to stay.",
          "'I will see what happens after graduation' - the officer hears no plan to return.",
          "'I will work part-time to manage expenses' - your funding must not depend on U.S. earnings.",
        ],
      },
      { h: "5. Hiding a refusal or a relative", p: ["Both are verifiable in seconds. A previous refusal with a clear explanation of what changed is survivable; a concealed one usually is not."] },
      { h: "6. A university you cannot defend", p: ["If you cannot say why this university and not the others that admitted you, the officer concludes someone else chose it - and that undermines the whole application."] },
      { h: "7. Over-answering", p: ["Long answers introduce facts nobody asked about, and every extra fact is another thing to contradict. Answer, then stop."] },
      { h: "8. Arguing", p: ["If the officer challenges you, address the challenge calmly with a fact. Debating the premise never ends well."] },
      { h: "9. A career plan with no location", p: ["'I want to be a data engineer' is a plan. 'I want to be a data engineer in Kathmandu's fintech sector, where my uncle's firm already hires them' is a reason to return."] },
    ],
  },
  {
    slug: "documents-checklist",
    category: "Documents",
    minutes: 5,
    title: "What to carry to your interview",
    excerpt: "The documents to hand over, the ones to have ready, and how to arrange them.",
    sections: [
      {
        h: "Hand these over without being asked twice",
        ul: [
          "Passport, valid for at least six months beyond your intended entry.",
          "Form I-20, signed by you and by your school official.",
          "DS-160 confirmation page with the barcode.",
          "SEVIS I-901 fee receipt.",
          "Interview appointment confirmation.",
          "One photograph meeting the current specification, in case the uploaded one fails.",
        ],
      },
      {
        h: "Have these ready in a second folder",
        ul: [
          "Bank statements covering the seasoning period, plus a bank balance certificate.",
          "Sponsor's income proof: salary certificate, tax filings, or audited business accounts.",
          "Education loan sanction letter, if you have one.",
          "Property valuation or rental income documents, if they are part of your funding.",
          "Academic transcripts, degree certificates, and your English test score report.",
          "Scholarship or assistantship award letter.",
        ],
      },
      {
        h: "How to arrange them",
        p: [
          "One folder, in the order above, with nothing loose. Officers rarely ask for the second folder - but the applicant who produces the right paper in two seconds looks like the applicant whose story is true.",
          "Do not carry documents you cannot explain. Being unable to describe a paper you handed over is worse than not having it.",
        ],
      },
    ],
  },
  {
    slug: "red-flags",
    category: "Red flags",
    minutes: 6,
    title: "The red flags officers act on",
    excerpt: "What raises suspicion, why it raises it, and what to do about each one before your interview.",
    sections: [
      {
        h: "Funding that does not close",
        p: ["If your documented funds do not cover the first-year cost of attendance on your I-20, the officer does the arithmetic before you finish speaking. Close the gap on paper first: seasoned savings, a sanctioned loan, a scholarship, or documented rental income."],
      },
      {
        h: "A recent, unexplained deposit",
        p: ["A balance that appeared last month invites the question of where it came from. Be ready with one sentence and one document. Money held for six months or more with a paper trail does not attract the question at all."],
      },
      {
        h: "Immigration-intent language",
        p: ["Officers listen for it in every answer, not just the ones about your plans. 'Settle', 'green card', 'opportunities are better there', or any suggestion that returning is optional will be treated as your real intention."],
      },
      {
        h: "Inconsistency with your own file",
        p: ["Sponsor, university, programme length and funding must be identical across your DS-160, your I-20 and your spoken answers. A contradiction is the single fastest route to a refusal because it cannot be explained away in the time available."],
      },
      {
        h: "A programme that does not fit your record",
        p: ["A sharp change of field with no bridging courses, certification or work looks like a visa route rather than a study plan. If you are switching, be ready to show the bridge you already built."],
      },
      {
        h: "Dependence on U.S. work",
        p: ["Any hint that you need a job in the United States to survive undermines the entire financial case. On-campus work and assistantships are permitted, but they may never be the plan for paying your fees."],
      },
    ],
  },
  {
    slug: "interview-day",
    category: "Interview day",
    minutes: 5,
    title: "Interview day, hour by hour",
    excerpt: "What happens at the embassy, in what order, and how to keep your head through it.",
    sections: [
      {
        h: "Before you arrive",
        ul: [
          "Check what you may bring. Most posts do not allow bags, phones or electronics inside, and there may be nowhere to store them.",
          "Arrive early but not hours early; you will usually not be let in before your slot.",
          "Dress the way you would for a university interview. Neat, not formal to the point of costume.",
        ],
      },
      {
        h: "Inside",
        ul: [
          "Security screening, then document check, then fingerprinting, then the interview queue.",
          "You will often hear the interviews ahead of yours. Do not adopt their answers - the officer has heard those answers all morning.",
          "The interview itself happens standing, through glass, in a few minutes.",
        ],
      },
      {
        h: "The outcome",
        p: [
          "You will usually be told at the window. An approval means your passport is retained for visa printing. A refusal under 214(b) means the officer was not satisfied about your circumstances; a 221(g) means administrative processing or a missing document, not a final no.",
          "If you are refused, ask what was missing, thank the officer, and leave. The next application is decided on new evidence, not on how you reacted to this one.",
        ],
      },
    ],
  },
  {
    slug: "business-visa",
    category: "Business visa",
    minutes: 5,
    title: "Business and visitor visas: how they differ from a student interview",
    excerpt: "An educational overview of B-1/B-2 interviews for applicants used to the student process.",
    sections: [
      {
        h: "A different question, the same logic",
        p: [
          "A B-1 business or B-2 visitor interview asks a narrower question than an F-1 interview: what exactly are you doing on this trip, who is paying for it, and what brings you home at the end of it.",
          "The non-immigrant intent test is identical. The difference is that a visitor has no I-20 and no multi-year story, so ties to home carry even more weight.",
        ],
      },
      {
        h: "What officers look for",
        ul: [
          "A specific, time-bounded purpose: a named conference, a named client, a named event with dates.",
          "An invitation or supporting letter from the U.S. party, where one exists.",
          "Clear funding for the trip, and clarity about who pays - you, your employer, or the host.",
          "Employment, business ownership, property or dependents that make returning obvious.",
          "A travel history showing you returned on time before.",
        ],
      },
      {
        h: "Common mistakes",
        ul: [
          "Vague purpose: 'business meetings' with no company, no dates and no agenda.",
          "A trip whose length does not match its stated purpose.",
          "Describing activity that requires a work visa - a B-1 does not permit employment in the United States.",
          "Letting a host's invitation replace your own explanation of why you are going.",
        ],
      },
      {
        h: "Practising for it",
        p: [
          "The mock interview in this app is tuned for F-1 student interviews. The habits transfer directly - short answers, verifiable facts, a clear return plan - but the question set is student-specific, so treat this page as background rather than rehearsal for a B-1 appointment.",
        ],
      },
    ],
  },
];

const FAQS = [
  ["Is this an official U.S. government service?", "No. NIEC Visa AI is independent interview practice built by NIEC. It is not affiliated with the U.S. Department of State, and nothing here is legal or immigration advice."],
  ["Can it predict whether I will get my visa?", "No, and be wary of anything that claims it can. The verdict on your report describes how this practice interview would likely have gone, so you can fix weak answers. The real decision belongs to a consular officer."],
  ["Should I memorise the improved answers?", "No. Officers recognise a memorised answer instantly, and a rehearsed delivery is itself a red flag. Use the improved answer as a framework: keep the structure and the facts, say it in your own words."],
  ["Do I need a microphone?", "No. Voice makes the simulation realistic, but every question can be answered by typing. If your browser does not support speech recognition, or you deny microphone access, the interview continues normally."],
  ["What happens to my personal and financial details?", "Your applicant profile, interview answers and coaching history are encrypted before they are stored. Nothing is published or shared with other students. Do not enter passport numbers or bank account numbers - the practice does not need them."],
  ["How many interviews should I do?", "Enough that your weakest category stops being your weakest. Most students need three or four runs before their funding and return-plan answers stop wandering, plus one run with the strict officer in the final week."],
];

/* ---------------------------------------------------------------- 5. views */

const main = () => $("#main");

function renderLoading() {
  main().innerHTML = `<div class="shell loading">Loading...</div>`;
}

/* ---- landing ---- */

function viewLanding() {
  main().innerHTML = `
    <section class="shell hero">
      <div>
        <span class="tag"><span class="dot"></span> F-1 interview practice, built for Nepali students</span>
        <h1>One vague answer is all it takes.</h1>
        <p class="lede">
          Your real interview lasts about three minutes. NIEC Visa AI puts you in front of a simulated consular
          officer first - one that asks about <em>your</em> university, <em>your</em> sponsor and <em>your</em> plan,
          drills into every weak answer, then shows you exactly where you would have been refused.
        </p>
        <div class="hero-cta">
          <a class="btn btn-primary btn-lg" href="#/signup">Start a mock interview</a>
          <a class="btn btn-ghost btn-lg" href="#/resources">Read the guides</a>
        </div>
        <p class="hero-note">Free to start. Voice or typing. Not affiliated with the U.S. government.</p>
      </div>

      <div class="mock-window" aria-hidden="true">
        <div class="mock-bar">
          <span class="mock-dots"><i></i><i></i><i></i></span>
          <span>Strict officer &middot; Question 4 of 10</span>
        </div>
        <div class="mock-body">
          <div class="bubble">
            <span class="who">CO</span>
            <span class="text">Your sponsor earns $22,000 a year. Your first year costs $34,000. How does that work?</span>
          </div>
          <div class="bubble me">
            <span class="text">My father's income covers living costs, and $40,000 of family savings has been in the account since last year. The scholarship takes $6,000 off tuition.</span>
          </div>
          <div class="listening"><span class="pulse"><i></i></span> Listening... speak your answer, or type instead</div>
        </div>
      </div>
    </section>

    <section class="shell">
      <div class="stat-strip">
        <div><strong>3</strong><span>officer styles</span><small>Strict, neutral and casual - each behaves differently.</small></div>
        <div><strong>10</strong><span>adaptive questions</span><small>Chosen from your own case, with live follow-ups.</small></div>
        <div><strong>3</strong><span>scores per answer</span><small>Answer, tone and clarity, graded instantly.</small></div>
        <div><strong>5</strong><span>scored categories</span><small>From academics to composure under pressure.</small></div>
      </div>
    </section>

    <section class="shell section" id="how">
      <div class="section-head center">
        <p class="eyebrow">How it works</p>
        <h2>Practise the interview, not the answers</h2>
        <p>Four steps, repeated until your weakest category stops being your weakest.</p>
      </div>
      <div class="grid grid-4">
        ${[
          ["01", "Build your case file", "University, programme, sponsor, funding, career plan, visa history. Six short steps - and every question afterwards comes from these facts."],
          ["02", "Choose your officer", "Strict, neutral or casual. The style changes how hard you get pushed, not just the wording."],
          ["03", "Sit the interview", "The officer speaks each question aloud. You answer with your voice. Weak answers get drilled, exactly like the real window."],
          ["04", "Read the verdict", "Scores for every answer, category breakdown, ranked red flags, and a stronger version of what you said."],
        ]
          .map(
            ([n, title, body]) => `
          <article class="card">
            <span class="step-num">${n}</span>
            <h3 style="margin-top:10px;font-size:17px">${esc(title)}</h3>
            <p style="margin-top:8px;font-size:14px;color:var(--ink-soft)">${esc(body)}</p>
          </article>`
          )
          .join("")}
      </div>
    </section>

    <section class="shell section" id="features">
      <div class="feature-split">
        <div>
          <p class="eyebrow">The simulator</p>
          <h2 style="font-size:clamp(23px,3.2vw,30px)">An officer that listens, then digs</h2>
          <p class="lede" style="margin-top:14px">
            This is not a list of questions on a timer. Say your university is "very good" and you will be asked which
            course, which professor, and why you rejected the other offers. Follow-ups are generated from what you just
            said.
          </p>
          <ul class="check-list">
            <li>One question at a time, spoken aloud</li>
            <li>Follow-up drills triggered by vague or rehearsed answers</li>
            <li>No coaching during the interview - officers do not coach</li>
            <li>Voice or typing, on any device</li>
          </ul>
        </div>
        <div class="card">
          <p class="eyebrow" style="margin-bottom:8px">After every answer</p>
          ${meter("Answer", 54, "Named no course, no figure, nothing verifiable.")}
          ${meter("Tone", 71, "Two hedging phrases weakened it.")}
          ${meter("Clarity", 82, "Followable, good length.")}
          <div class="improved">
            <h4>Stronger version</h4>
            <p style="font-size:14px">I chose Texas State for the data-systems track in its MS Computer Science - the applied analytics capstone is what the fintech roles I am targeting in Kathmandu hire for.</p>
          </div>
        </div>
      </div>

      <div class="feature-split reverse" style="margin-top:64px">
        <div>
          <p class="eyebrow">Personalisation</p>
          <h2 style="font-size:clamp(23px,3.2vw,30px)">Your case, not a generic script</h2>
          <p class="lede" style="margin-top:14px">
            Two students with the same university get different interviews. A funding gap in your file becomes three
            money questions. A previous refusal becomes the question you fear most - asked early, and asked again later.
          </p>
          <ul class="check-list">
            <li>Questions written against your applicant profile</li>
            <li>Weak spots in your file get more airtime</li>
            <li>Improved answers built from your real numbers</li>
            <li>Every interview freezes a snapshot, so old reports still make sense</li>
          </ul>
        </div>
        <div class="card">
          <p class="eyebrow" style="margin-bottom:10px">Red flags, worst first</p>
          <div class="flag">
            <span class="pill pill-bad">high</span>
            <div><b>Sponsor mismatch</b><p>Your file says father; this answer said uncle.</p></div>
          </div>
          <div class="flag">
            <span class="pill pill-bad">high</span>
            <div><b>Funding depends on U.S. work</b><p>You implied a part-time job will cover living costs.</p></div>
          </div>
          <div class="flag">
            <span class="pill pill-warn">medium</span>
            <div><b>Vague, unverifiable answer</b><p>No names, numbers or specifics for the officer to check.</p></div>
          </div>
        </div>
      </div>
    </section>

    <section class="shell section">
      <div class="section-head center">
        <p class="eyebrow">Scoring</p>
        <h2>Measured the way an officer listens</h2>
        <p>Every answer is graded on three dimensions, and every interview rolls up into five categories.</p>
      </div>
      <div class="grid grid-3">
        ${[
          ["Answer", "Did you answer what was asked, with facts the officer can verify?"],
          ["Tone", "Hedging, filler and pace - what your delivery signals about your own certainty."],
          ["Clarity", "Plain, followable English of the right length. Three or four sentences."],
          ["Academic & Programme", "Do you know your curriculum, and does the choice make sense?"],
          ["Financial Readiness", "Is the money real, documented and enough?"],
          ["Intent to Return", "Is there a specific reason for you to go home?"],
        ]
          .map(
            ([title, body]) => `
          <article class="card">
            <h3 style="font-size:16px">${esc(title)}</h3>
            <p style="margin-top:8px;font-size:14px;color:var(--ink-soft)">${esc(body)}</p>
          </article>`
          )
          .join("")}
      </div>
    </section>

    <section class="shell section" id="faq">
      <div class="section-head center">
        <p class="eyebrow">FAQ</p>
        <h2>The questions students ask us</h2>
      </div>
      <div class="card faq">
        ${FAQS.map(
          ([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`
        ).join("")}
      </div>
    </section>

    <section class="shell">
      <div class="cta-band">
        <h2>Find your weak answers here, not at the window.</h2>
        <p>Build your case file, choose an officer, and sit the interview. It takes about ten minutes.</p>
        <div class="row">
          <a class="btn btn-primary btn-lg" href="#/signup">Create your free account</a>
          <a class="btn btn-ghost btn-lg" href="#/login">I already have one</a>
        </div>
      </div>
    </section>
  `;
}

/* ---- auth ---- */

function authShell(title, intro, inner) {
  main().innerHTML = `
    <div class="shell auth-wrap">
      <div class="card">
        <h1 style="font-size:24px">${esc(title)}</h1>
        <p style="margin-top:8px;color:var(--ink-soft);font-size:14.5px">${esc(intro)}</p>
        <div style="margin-top:22px" id="authBody">${inner}</div>
      </div>
      <p class="muted" style="margin-top:16px;text-align:center;line-height:1.6">
        Educational interview preparation only. Not legal or immigration advice, and not affiliated with the U.S.
        Department of State.
      </p>
    </div>`;
}

function googleButtonHtml() {
  return state.serverConfig?.googleEnabled
    ? `<div class="divider">or</div><div id="googleButton" style="display:flex;justify-content:center"></div>`
    : "";
}

/** Renders Google Identity Services when a client id is configured. */
function mountGoogleButton() {
  if (!state.serverConfig?.googleEnabled) return;
  const container = $("#googleButton");
  if (!container) return;

  const render = () => {
    if (!window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({
      client_id: state.serverConfig.googleClientId,
      callback: async ({ credential }) => {
        try {
          const data = await api("/api/auth/google", { method: "POST", body: { credential } });
          setToken(data.token);
          await loadSession();
          renderChrome();
          toast(`Signed in as ${data.user.fullName}.`, "success");
          location.hash = state.profile ? "#/dashboard" : "#/onboarding";
        } catch (error) {
          toast(error.message, "error");
        }
      },
    });
    window.google.accounts.id.renderButton(container, { theme: "outline", size: "large", width: 320 });
  };

  if (window.google?.accounts?.id) return render();
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  script.onload = render;
  document.head.append(script);
}

function viewSignup() {
  authShell(
    "Start practising",
    "Create an account, build your applicant profile, and sit your first mock interview in about ten minutes.",
    `
    <form id="signupForm" novalidate>
      <div id="formError"></div>
      <div class="field-group">
        <label class="label" for="fullName">Full name</label>
        <input id="fullName" name="fullName" autocomplete="name" required placeholder="Your name" />
      </div>
      <div class="field-group">
        <label class="label" for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com" />
      </div>
      <div class="field-group">
        <label class="label" for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" required
          placeholder="At least 8 characters, with a number" />
      </div>
      <label class="checkbox" style="margin:14px 0 18px">
        <input type="checkbox" id="marketingOptIn" />
        <span>Email me occasional NIEC study-abroad updates. You can turn this off at any time in Settings.</span>
      </label>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Create account</button>
    </form>
    ${googleButtonHtml()}
    <p style="margin-top:18px;text-align:center;font-size:14px;color:var(--ink-soft)">
      Already have an account? <a href="#/login">Sign in</a>
    </p>`
  );

  mountGoogleButton();
  $("#signupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#signupForm button[type=submit]");
    setBusy(button, true, "Creating...");
    try {
      const data = await api("/api/auth/register", {
        method: "POST",
        body: {
          fullName: $("#fullName").value,
          email: $("#email").value,
          password: $("#password").value,
          marketingOptIn: $("#marketingOptIn").checked,
        },
      });
      setToken(data.token);
      await loadSession();
      renderChrome();
      toast("Account created. Now build your applicant profile.", "success");
      location.hash = "#/onboarding";
    } catch (error) {
      $("#formError").innerHTML = `<div class="alert alert-error">${esc(error.message)}</div>`;
      setBusy(button, false);
    }
  });
}

function viewLogin() {
  authShell("Welcome back", "Pick up where you left off - your case file and every past report are waiting.", `
    <form id="loginForm" novalidate>
      <div id="formError"></div>
      <div class="field-group">
        <label class="label" for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com" />
      </div>
      <div class="field-group">
        <label class="label" for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Your password" />
      </div>
      <p style="margin:-4px 0 16px;font-size:13.5px"><a href="#/forgot">Forgot your password?</a></p>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Sign in</button>
    </form>
    ${googleButtonHtml()}
    <p style="margin-top:18px;text-align:center;font-size:14px;color:var(--ink-soft)">
      New here? <a href="#/signup">Create an account</a>
    </p>`);

  mountGoogleButton();
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#loginForm button[type=submit]");
    setBusy(button, true, "Signing in...");
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { email: $("#email").value, password: $("#password").value },
      });
      setToken(data.token);
      await loadSession();
      renderChrome();
      toast(`Welcome back, ${data.user.fullName.split(" ")[0]}.`, "success");
      location.hash = state.profile ? "#/dashboard" : "#/onboarding";
    } catch (error) {
      $("#formError").innerHTML = `<div class="alert alert-error">${esc(error.message)}</div>`;
      setBusy(button, false);
    }
  });
}

function viewForgot() {
  authShell("Reset your password", "Enter your email and we will send a link to choose a new password.", `
    <form id="forgotForm" novalidate>
      <div id="formError"></div>
      <div class="field-group">
        <label class="label" for="email">Email</label>
        <input id="email" type="email" autocomplete="email" required placeholder="you@example.com" />
      </div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Send reset link</button>
    </form>
    <p style="margin-top:18px;text-align:center;font-size:14px"><a href="#/login">Back to sign in</a></p>`);

  $("#forgotForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#forgotForm button[type=submit]");
    setBusy(button, true, "Sending...");
    try {
      const data = await api("/api/auth/forgot-password", { method: "POST", body: { email: $("#email").value } });
      let html = `<div class="alert alert-good">${esc(data.message)}</div>`;
      if (data.devResetUrl) {
        // No email provider configured: show the link so the flow still works.
        html += `<div class="alert alert-info" style="word-break:break-all">
          No email provider is configured on this server, so here is your reset link:
          <a href="${esc(data.devResetUrl)}">${esc(data.devResetUrl)}</a>
        </div>`;
      }
      $("#authBody").innerHTML = html + `<p style="margin-top:16px;text-align:center"><a href="#/login">Back to sign in</a></p>`;
    } catch (error) {
      $("#formError").innerHTML = `<div class="alert alert-error">${esc(error.message)}</div>`;
      setBusy(button, false);
    }
  });
}

function viewReset(query) {
  const token = query.get("token") || "";
  authShell("Choose a new password", "This link can only be used once, and expires within the hour.", `
    <form id="resetForm" novalidate>
      <div id="formError"></div>
      ${token ? "" : `<div class="alert alert-error">This reset link is missing its token. Request a new one.</div>`}
      <div class="field-group">
        <label class="label" for="password">New password</label>
        <input id="password" type="password" autocomplete="new-password" required placeholder="At least 8 characters, with a number" />
      </div>
      <button class="btn btn-primary btn-block btn-lg" type="submit"${token ? "" : " disabled"}>Set new password</button>
    </form>
    <p style="margin-top:18px;text-align:center;font-size:14px"><a href="#/forgot">Request a new link</a></p>`);

  $("#resetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#resetForm button[type=submit]");
    setBusy(button, true, "Saving...");
    try {
      const data = await api("/api/auth/reset-password", {
        method: "POST",
        body: { token, password: $("#password").value },
      });
      setToken(data.token);
      await loadSession();
      renderChrome();
      toast("Password updated and you are signed in.", "success");
      location.hash = "#/dashboard";
    } catch (error) {
      $("#formError").innerHTML = `<div class="alert alert-error">${esc(error.message)}</div>`;
      setBusy(button, false);
    }
  });
}

/* ---- profile ---- */

function profileFieldHtml([key, label, placeholder, long], value) {
  const id = `pf_${key}`;
  const control = long
    ? `<textarea id="${id}" name="${key}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input type="text" id="${id}" name="${key}" placeholder="${esc(placeholder)}" value="${esc(value)}" />`;
  return `<div class="field-group"${long ? ' style="grid-column:1/-1"' : ""}>
    <label class="label" for="${id}">${esc(label)}</label>${control}</div>`;
}

function viewOnboarding() {
  if (!requireAuth()) return;
  let step = 0;
  const values = { ...(state.profile || {}) };

  const render = () => {
    const group = PROFILE_STEPS[step];
    const progress = Math.round(((step + 1) / PROFILE_STEPS.length) * 100);
    main().innerHTML = `
      <div class="shell page" style="max-width:820px">
        <div class="page-head">
          <p class="eyebrow">Your case file</p>
          <h1>The officer reads your file before you speak.</h1>
          <p>
            Fill this in from your I-20 and DS-160 so every number matches your documents. It is used to write your
            questions and to check your answers for contradictions. Do not enter passport or bank account numbers.
          </p>
        </div>

        <div class="card">
          <div class="spread" style="font-size:13px;color:var(--ink-faint)">
            <span>Step ${step + 1} of ${PROFILE_STEPS.length}</span><span>${progress}% complete</span>
          </div>
          <div class="meter-track" style="margin:10px 0 24px"><div class="meter-fill" style="width:${progress}%"></div></div>

          <h2 style="font-size:20px">${esc(group.title)}</h2>
          <p style="margin-top:6px;color:var(--ink-soft);font-size:14.5px">${esc(group.intro)}</p>

          <form id="stepForm" style="margin-top:20px" class="grid grid-2">
            ${group.fields.map((field) => profileFieldHtml(field, values[field[0]] || "")).join("")}
          </form>

          <div class="row" style="margin-top:20px;border-top:1px solid var(--line);padding-top:18px">
            ${step > 0 ? `<button class="btn btn-ghost" id="backBtn" type="button">Back</button>` : ""}
            <button class="btn btn-primary" id="nextBtn" type="button">
              ${step === PROFILE_STEPS.length - 1 ? "Finish and choose an officer" : "Save and continue"}
            </button>
            <span class="muted">Every field is optional - the more you fill in, the more personal the interview.</span>
          </div>
        </div>
      </div>`;

    const collect = () => {
      for (const [key] of group.fields) values[key] = $(`#pf_${key}`).value.trim();
    };

    $("#backBtn")?.addEventListener("click", () => {
      collect();
      step -= 1;
      render();
    });

    $("#nextBtn").addEventListener("click", async () => {
      collect();
      const button = $("#nextBtn");
      setBusy(button, true, "Saving...");
      try {
        const data = await api("/api/profile", { method: "PUT", body: values });
        state.profile = data.profile;
        state.completeness = data.completeness;
        if (step === PROFILE_STEPS.length - 1) {
          toast("Applicant profile saved.", "success");
          location.hash = "#/interview";
        } else {
          step += 1;
          render();
        }
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
  };

  render();
}

function viewProfile() {
  if (!requireAuth()) return;
  const values = { ...(state.profile || {}) };

  main().innerHTML = `
    <div class="shell page" style="max-width:900px">
      <div class="spread page-head">
        <div>
          <h1>My case file</h1>
          <p>Keep this identical to your I-20 and DS-160. Interviews you already finished keep their own snapshot, so
             editing here never rewrites an old report.</p>
        </div>
        <div style="text-align:right">
          <strong style="font-family:var(--font-display);font-size:28px;color:var(--brand)">${state.completeness}%</strong>
          <div class="muted">complete</div>
        </div>
      </div>

      <form id="profileForm">
        ${PROFILE_STEPS.map(
          (group) => `
          <section class="card" style="margin-bottom:18px">
            <h2 style="font-size:18px">${esc(group.title)}</h2>
            <p style="margin-top:5px;color:var(--ink-soft);font-size:14px">${esc(group.intro)}</p>
            <div class="grid grid-2" style="margin-top:18px">
              ${group.fields.map((field) => profileFieldHtml(field, values[field[0]] || "")).join("")}
            </div>
          </section>`
        ).join("")}
        <div class="row">
          <button class="btn btn-primary" id="saveProfile" type="submit">Save changes</button>
          <a class="btn btn-ghost" href="#/interview">Start an interview</a>
        </div>
      </form>
    </div>`;

  $("#profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#saveProfile");
    setBusy(button, true, "Saving...");
    const payload = {};
    for (const key of PROFILE_KEYS) payload[key] = $(`#pf_${key}`)?.value.trim() ?? "";
    try {
      const data = await api("/api/profile", { method: "PUT", body: payload });
      state.profile = data.profile;
      state.completeness = data.completeness;
      toast("Case file saved.", "success");
      setBusy(button, false);
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });
}

/* ---- dashboard ---- */

async function viewDashboard() {
  if (!requireAuth()) return;
  renderLoading();

  const [{ analytics }, { interviews }] = await Promise.all([
    api("/api/analytics"),
    api("/api/interviews"),
  ]);

  const firstName = state.user.fullName.split(" ")[0];
  const p = state.profile;
  const missing = ["fullName", "usUniversity", "program", "sponsorRelation", "careerGoal"].filter(
    (key) => !String(p?.[key] || "").trim()
  );

  main().innerHTML = `
    <div class="shell page">
      <div class="spread page-head">
        <div>
          <h1>Welcome back, ${esc(firstName)}</h1>
          <p>${p?.usUniversity ? `${esc(p.program || "Your programme")} at ${esc(p.usUniversity)}` : "Your applicant profile is not set up yet."}</p>
        </div>
        <a class="btn btn-primary btn-lg" href="#/interview">Start an interview</a>
      </div>

      ${
        missing.length
          ? `<div class="alert alert-warn">Your case file is missing <b>${missing.length}</b> key detail${missing.length > 1 ? "s" : ""}.
             <a href="#/profile">Complete it</a> so the officer asks about your actual case.</div>`
          : ""
      }
      ${
        analytics.completed === 0
          ? `<div class="alert alert-info">No interviews yet. Start on <b>Neutral</b> - it is the closest match to a real window.</div>`
          : ""
      }

      <div class="grid grid-side">
        <div class="card" style="text-align:center">
          ${ring(analytics.readiness, "readiness")}
          <p class="muted" style="margin-top:14px;line-height:1.6">
            Based on your last two interviews, how much you have practised, and unresolved high-risk flags.
          </p>
        </div>

        <div class="card">
          <div class="grid grid-3">
            <div class="stat-block"><span>Interviews</span><strong>${analytics.completed}</strong></div>
            <div class="stat-block">
              <span>Last score</span><strong class="score-${analytics.lastScore !== null ? scoreClass(analytics.lastScore) : "warn"}">${analytics.lastScore ?? "-"}</strong>
              ${analytics.delta !== null ? `<div class="muted">${analytics.delta >= 0 ? "+" : ""}${analytics.delta} vs previous</div>` : ""}
            </div>
            <div class="stat-block"><span>Best score</span><strong>${analytics.bestScore ?? "-"}</strong></div>
          </div>
          ${
            analytics.series.length > 1
              ? `<div style="margin-top:24px;border-top:1px solid var(--line);padding-top:18px">
                   <p class="muted" style="margin-bottom:8px;text-transform:uppercase;letter-spacing:.1em">Score history</p>
                   ${sparkline(analytics.series.map((s) => s.score))}
                 </div>`
              : ""
          }
          ${
            analytics.openHighFlags > 0
              ? `<div class="alert alert-error" style="margin:18px 0 0">${analytics.openHighFlags} high-risk flag${analytics.openHighFlags > 1 ? "s" : ""} in your last interview. Fix those before anything else.</div>`
              : ""
          }
        </div>
      </div>

      ${
        analytics.categories.length
          ? `<div class="grid grid-2" style="margin-top:18px">
              <div class="card">
                <h2 style="font-size:18px">Category averages</h2>
                <div style="margin-top:18px">
                  ${analytics.categories.map((c) => meter(c.category, c.average, `${c.sessions} interview(s)`)).join("")}
                </div>
              </div>
              <div class="card">
                <h2 style="font-size:18px">What to practise next</h2>
                ${
                  analytics.recommended.length
                    ? `<div style="margin-top:16px">${analytics.recommended
                        .map(
                          (label) =>
                            `<div class="list-row"><h3>${esc(label)}</h3><a class="btn btn-ghost btn-sm" href="#/interview">Practise</a></div>`
                        )
                        .join("")}</div>`
                    : `<p style="margin-top:14px;color:var(--ink-soft);font-size:14.5px">Every category is above 75. Run one interview with the strict officer to see whether it holds under pressure.</p>`
                }
                <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px">
                  ${meter("Answer", analytics.dimensions.answer)}
                  ${meter("Tone", analytics.dimensions.tone)}
                  ${meter("Clarity", analytics.dimensions.clarity)}
                </div>
              </div>
            </div>`
          : ""
      }

      <section class="section" style="margin-top:44px">
        <div class="spread" style="margin-bottom:16px">
          <h2 style="font-size:21px">Your interviews</h2>
          ${interviews.length ? `<a href="#/history">See all</a>` : ""}
        </div>
        ${interviews.length ? interviews.slice(0, 5).map(interviewRow).join("") : `<div class="card empty">Nothing here yet - your first report will appear here.</div>`}
      </section>
    </div>`;
}

function interviewRow(interview) {
  const done = interview.status === "completed";
  return `
    <div class="list-row">
      <div>
        <h3>${esc(interview.mode.charAt(0).toUpperCase() + interview.mode.slice(1))} officer</h3>
        <p class="muted">${formatDateTime(interview.createdAt)} &middot; ${interview.answered} answer${interview.answered === 1 ? "" : "s"}</p>
      </div>
      <div class="row">
        ${done ? verdictPill(interview.verdict) : `<span class="pill pill-warn">in progress</span>`}
        ${done ? `<strong style="font-family:var(--font-display);font-size:19px" class="score-${scoreClass(interview.overallScore)}">${interview.overallScore}</strong>` : ""}
        <a class="btn btn-ghost btn-sm" href="${done ? `#/results/${interview.id}` : `#/interview/${interview.id}`}">
          ${done ? "Report" : "Resume"}
        </a>
      </div>
    </div>`;
}

async function viewHistory() {
  if (!requireAuth()) return;
  renderLoading();
  const { interviews } = await api("/api/interviews");
  main().innerHTML = `
    <div class="shell page">
      <div class="page-head">
        <h1>Interview history</h1>
        <p>Every practice interview you have run, newest first. Reports are kept so you can compare them over time.</p>
      </div>
      ${interviews.length ? interviews.map(interviewRow).join("") : `<div class="card empty">No interviews yet. <a href="#/interview">Run your first one</a>.</div>`}
    </div>`;
}

/* ---- analytics ---- */

async function viewAnalytics() {
  if (!requireAuth()) return;
  renderLoading();
  const { analytics } = await api("/api/analytics");

  if (!analytics.completed) {
    main().innerHTML = `
      <div class="shell page">
        <div class="page-head"><h1>Your progress</h1><p>Analytics appear once you finish your first interview.</p></div>
        <div class="card empty"><a class="btn btn-primary" href="#/interview">Run your first interview</a></div>
      </div>`;
    return;
  }

  main().innerHTML = `
    <div class="shell page">
      <div class="page-head">
        <h1>Your progress</h1>
        <p>Performance across ${analytics.completed} completed interview${analytics.completed === 1 ? "" : "s"}.</p>
      </div>

      <div class="grid grid-side">
        <div class="card" style="text-align:center">
          ${ring(analytics.readiness, "readiness")}
          <p class="muted" style="margin-top:12px">Average ${analytics.averageScore} &middot; best ${analytics.bestScore}</p>
        </div>
        <div class="card">
          <h2 style="font-size:18px">Score history</h2>
          <div style="margin-top:14px">${sparkline(analytics.series.map((s) => s.score))}</div>
          <div style="margin-top:16px">
            ${analytics.series
              .map(
                (s) => `<div class="list-row" style="padding:11px 14px">
                  <div><h3 style="font-size:14px">${esc(s.mode)} officer</h3><p class="muted">${formatDate(s.date)}</p></div>
                  <div class="row">${verdictPill(s.verdict)}<a class="btn btn-ghost btn-sm" href="#/results/${esc(s.id)}">Report</a></div>
                </div>`
              )
              .join("")}
          </div>
        </div>
      </div>

      <div class="grid grid-2" style="margin-top:18px">
        <div class="card">
          <h2 style="font-size:18px">By category</h2>
          <div style="margin-top:18px">${analytics.categories.map((c) => meter(c.category, c.average, `${c.sessions} interview(s)`)).join("")}</div>
        </div>
        <div class="card">
          <h2 style="font-size:18px">By dimension</h2>
          <div style="margin-top:18px">
            ${meter("Answer", analytics.dimensions.answer, "Content the officer can verify.")}
            ${meter("Tone", analytics.dimensions.tone, "Certainty in your delivery.")}
            ${meter("Clarity", analytics.dimensions.clarity, "How followable your answers are.")}
          </div>
          ${
            analytics.strongest && analytics.weakest
              ? `<p style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px;font-size:14.5px;color:var(--ink-soft)">
                  Strongest: <b>${esc(analytics.strongest.category)}</b>. Weakest: <b>${esc(analytics.weakest.category)}</b>.
                 </p>`
              : ""
          }
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------- 6. interview runtime */

const speech = {
  synth: window.speechSynthesis || null,
  recognition: null,
  listening: false,
};

function speak(text) {
  if (!speech.synth) return;
  speech.synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.97;
  const voices = speech.synth.getVoices();
  const voice =
    voices.find((v) => v.lang.startsWith("en") && /Google|Natural|Aria/i.test(v.name)) ??
    voices.find((v) => v.lang.startsWith("en"));
  if (voice) utterance.voice = voice;
  speech.synth.speak(utterance);
}

function stopSpeaking() {
  speech.synth?.cancel();
}

const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;

function startListening(seed, onTranscript, onEnd) {
  if (!RecognitionCtor || speech.listening) return false;
  const recognition = new RecognitionCtor();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalText = seed ? `${seed.trim()} ` : "";
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += `${result[0].transcript} `;
      else interim += result[0].transcript;
    }
    onTranscript((finalText + interim).trim());
  };
  const finish = () => {
    speech.listening = false;
    speech.recognition = null;
    onEnd?.();
  };
  recognition.onend = finish;
  recognition.onerror = finish;

  speech.recognition = recognition;
  speech.listening = true;
  recognition.start();
  return true;
}

function stopListening() {
  speech.recognition?.stop();
}

/** Interview setup: choose the officer, then create the session. */
function viewInterviewSetup() {
  if (!requireAuth()) return;
  if (!state.profile) {
    location.hash = "#/onboarding";
    return;
  }

  let mode = "neutral";
  const modes = state.serverConfig?.modes ?? [
    { id: "strict", name: "Strict officer", blurb: "", greeting: "" },
    { id: "neutral", name: "Neutral officer", blurb: "", greeting: "" },
    { id: "casual", name: "Casual officer", blurb: "", greeting: "" },
  ];

  main().innerHTML = `
    <div class="shell page" style="max-width:940px">
      <div class="page-head">
        <p class="eyebrow">New interview</p>
        <h1>Set up the window</h1>
        <p>Start with the neutral officer to find your weak categories, then run the same case again with the strict
           officer. ${esc(String(state.serverConfig?.questionCount ?? 10))} questions, plus follow-up drills when an answer is thin.</p>
      </div>

      <div class="card">
        <h2 style="font-size:18px">Choose your officer</h2>
        <div class="grid grid-3" style="margin-top:16px">
          ${modes
            .map(
              (m) => `
            <button class="mode-card" type="button" data-mode="${esc(m.id)}" aria-pressed="${m.id === mode}">
              <h3>${esc(m.name)}</h3>
              <p>${esc(m.blurb)}</p>
              <q>${esc(m.greeting)}</q>
            </button>`
            )
            .join("")}
        </div>

        <div class="row" style="margin-top:24px;border-top:1px solid var(--line);padding-top:20px">
          <button class="btn btn-primary btn-lg" id="startBtn" type="button">Enter the interview</button>
          <span class="muted">
            ${RecognitionCtor ? "Your browser will ask for microphone access on the next screen. Typing always works too." : "This browser does not support speech recognition - you will type your answers."}
          </span>
        </div>
      </div>
    </div>`;

  $$(".mode-card").forEach((button) =>
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      $$(".mode-card").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    })
  );

  $("#startBtn").addEventListener("click", async () => {
    const button = $("#startBtn");
    setBusy(button, true, "Preparing the window...");
    try {
      const data = await api("/api/interviews", { method: "POST", body: { mode } });
      location.hash = `#/interview/${data.id}`;
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });
}

/** The live interview. */
async function viewInterviewRun(id) {
  if (!requireAuth()) return;
  renderLoading();

  let session;
  try {
    session = await api(`/api/interviews/${id}`);
  } catch (error) {
    toast(error.message, "error");
    location.hash = "#/dashboard";
    return;
  }

  if (session.status === "completed") {
    location.hash = `#/results/${id}`;
    return;
  }

  const runtime = {
    id,
    question: session.question,
    total: session.total,
    answered: session.answered,
    transcript: session.transcript,
    started: false,
    answer: "",
    askedAt: Date.now(),
    lastReview: null,
  };
  state.interview = runtime;

  const renderStart = () => {
    main().innerHTML = `
      <div class="shell page interview-shell">
        <div class="card" style="text-align:center;padding:40px 26px">
          <p class="eyebrow">${esc(session.mode)} officer</p>
          <h1 style="font-size:26px;margin-top:6px">You are next at the window.</h1>
          <p class="lede" style="max-width:44ch;margin:14px auto 0">
            The officer asks ${runtime.total} questions, one at a time, and follows up when an answer is thin.
            Answer out loud if you can - speaking is the part students get wrong.
          </p>
          <div style="margin-top:26px"><button class="btn btn-primary btn-lg" id="beginBtn" type="button">Begin interview</button></div>
          <p class="muted" style="margin-top:14px">
            ${RecognitionCtor ? "Your browser will ask for microphone access. You can also type every answer." : "Speech recognition is unavailable in this browser - type your answers."}
          </p>
        </div>
      </div>`;

    $("#beginBtn").addEventListener("click", () => {
      runtime.started = true;
      // Must happen inside the click: iOS unlocks speech only on a gesture.
      speak(session.greeting);
      renderQuestion();
      setTimeout(() => speak(runtime.question.question), 900);
    });
  };

  const renderQuestion = () => {
    if (!runtime.question) return;
    const q = runtime.question;
    const progress = Math.round((runtime.answered / runtime.total) * 100);

    main().innerHTML = `
      <div class="shell page interview-shell">
        <div class="card tight">
          <div class="interview-top">
            <div class="officer-badge">
              <span class="who">CO</span>
              <div>
                <b>${esc(session.mode.charAt(0).toUpperCase() + session.mode.slice(1))} officer</b>
                <div class="muted">Question ${q.number} of ${q.total}${q.isFollowUp ? " &middot; follow-up" : ""}</div>
              </div>
            </div>
            <button class="btn btn-ghost btn-sm" id="finishBtn" type="button"${runtime.answered ? "" : " disabled"}>End and get report</button>
          </div>
          <div class="meter-track" style="margin-top:14px"><div class="meter-fill" style="width:${progress}%"></div></div>
        </div>

        <div class="card" style="margin-top:16px">
          <span class="pill pill-brand">${esc(q.category)}</span>
          <p class="question-text">${esc(q.question)}</p>

          <div class="row" style="margin-top:16px">
            ${speech.synth ? `<button class="btn btn-ghost btn-sm" id="repeatBtn" type="button">Repeat question</button>` : ""}
            ${RecognitionCtor ? `<button class="btn btn-secondary btn-sm" id="micBtn" type="button">Record answer</button>` : ""}
            <span id="micState" class="muted"></span>
          </div>

          <div class="field-group" style="margin-top:18px">
            <label class="label" for="answerBox">Your answer</label>
            <textarea id="answerBox" rows="5" placeholder="Speak, or type your answer here...">${esc(runtime.answer)}</textarea>
            <div class="answer-meta"><span id="wordCount">0 words</span><span>Three or four sentences is the target.</span></div>
          </div>

          <div id="reviewSlot"></div>

          <div class="row" style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px">
            <button class="btn btn-primary" id="submitBtn" type="button">Submit answer</button>
            <span class="muted">The officer does not coach you during the interview - feedback comes after each answer and at the end.</span>
          </div>
        </div>

        ${
          runtime.transcript.length
            ? `<div class="card" style="margin-top:16px">
                <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint)">Answered so far</h2>
                <div style="margin-top:14px">
                  ${runtime.transcript
                    .map(
                      (t) => `<div class="transcript-item">
                        <p>${esc(t.question)}</p>
                        <p>${esc(t.answer)}</p>
                      </div>`
                    )
                    .join("")}
                </div>
              </div>`
            : ""
        }
      </div>`;

    const box = $("#answerBox");
    const updateCount = () => {
      const n = box.value.trim() ? box.value.trim().split(/\s+/).length : 0;
      $("#wordCount").textContent = `${n} word${n === 1 ? "" : "s"}`;
      runtime.answer = box.value;
    };
    box.addEventListener("input", updateCount);
    updateCount();

    $("#repeatBtn")?.addEventListener("click", () => speak(q.question));

    $("#micBtn")?.addEventListener("click", () => {
      if (speech.listening) {
        stopListening();
        return;
      }
      const started = startListening(
        box.value,
        (text) => {
          box.value = text;
          updateCount();
        },
        () => {
          $("#micBtn").textContent = "Record answer";
          $("#micState").textContent = "";
        }
      );
      if (started) {
        $("#micBtn").textContent = "Stop recording";
        $("#micState").textContent = "listening...";
      } else {
        toast("Could not start the microphone. Type your answer instead.", "error");
      }
    });

    $("#submitBtn").addEventListener("click", submitAnswer);
    $("#finishBtn").addEventListener("click", finishInterview);

    runtime.askedAt = Date.now();
  };

  const submitAnswer = async () => {
    const box = $("#answerBox");
    const answer = box.value.trim();
    if (!answer) {
      toast("Say or type something before moving on.", "error");
      return;
    }
    stopListening();
    stopSpeaking();

    const button = $("#submitBtn");
    setBusy(button, true, "Scoring...");
    try {
      const data = await api(`/api/interviews/${id}/answer`, {
        method: "POST",
        body: { answer, seconds: Math.round((Date.now() - runtime.askedAt) / 1000) },
      });

      runtime.transcript.push({
        question: runtime.question.question,
        answer,
        scores: data.scores,
        feedback: data.feedback,
      });
      runtime.answered = data.answered;
      runtime.total = data.total;
      runtime.answer = "";
      runtime.lastReview = { scores: data.scores, feedback: data.feedback };

      if (data.done) {
        await finishInterview();
        return;
      }

      runtime.question = data.question;
      renderQuestion();
      showReview(runtime.lastReview);
      setTimeout(() => speak(runtime.question.question), 700);
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  };

  const showReview = (review) => {
    const slot = $("#reviewSlot");
    if (!slot || !review) return;
    slot.innerHTML = `
      <div class="answer-review">
        <p class="muted" style="text-transform:uppercase;letter-spacing:.1em">Previous answer</p>
        <div class="review-scores">
          <div><b class="score-${scoreClass(review.scores.answer)}">${review.scores.answer}</b> Answer</div>
          <div><b class="score-${scoreClass(review.scores.tone)}">${review.scores.tone}</b> Tone</div>
          <div><b class="score-${scoreClass(review.scores.clarity)}">${review.scores.clarity}</b> Clarity</div>
        </div>
        <p style="margin-top:8px;font-size:14px;color:var(--ink-soft)">${esc(review.feedback)}</p>
      </div>`;
  };

  const finishInterview = async () => {
    stopListening();
    stopSpeaking();
    main().innerHTML = `<div class="shell loading">The officer is writing up your file...</div>`;
    try {
      await api(`/api/interviews/${id}/finish`, { method: "POST" });
      state.interview = null;
      await refreshUnread();
      location.hash = `#/results/${id}`;
    } catch (error) {
      toast(error.message, "error");
      location.hash = "#/dashboard";
    }
  };

  if (session.answered > 0 && session.question) {
    // Resuming a session that was left open.
    runtime.started = true;
    renderQuestion();
  } else {
    renderStart();
  }
}

/* ---- results ---- */

async function viewResults(id) {
  if (!requireAuth()) return;
  renderLoading();

  let results;
  try {
    ({ results } = await api(`/api/interviews/${id}/results`));
  } catch (error) {
    toast(error.message, "error");
    location.hash = "#/dashboard";
    return;
  }

  const insights = (kind) => results.insights.filter((i) => i.kind === kind);
  const flags = insights("red_flag").sort(
    (a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.severity] ?? 3)
  );

  main().innerHTML = `
    <div class="shell page" style="max-width:960px">
      <div class="card">
        <div class="spread">
          <div>
            <p class="eyebrow">Interview report</p>
            <h1 style="font-size:26px">${esc(results.mode.charAt(0).toUpperCase() + results.mode.slice(1))} officer</h1>
            <p class="muted" style="margin-top:6px">
              ${formatDate(results.completedAt)} &middot; ${results.questions.filter((q) => q.answer).length} answers graded
              &middot; ${results.engine === "provider" ? `AI engine (${esc(results.modelUsed || "provider")})` : "built-in engine"}
            </p>
            <div style="margin-top:12px">${verdictPill(results.verdict)}</div>
          </div>
          ${ring(results.overallScore, "overall")}
        </div>
        <p style="margin-top:22px;border-top:1px solid var(--line);padding-top:18px;font-size:15.5px;line-height:1.7">
          ${esc(results.summary)}
        </p>
      </div>

      <div class="grid grid-2" style="margin-top:18px">
        <div class="card">
          <h2 style="font-size:18px">By category</h2>
          <div style="margin-top:18px">${results.categoryScores.map((c) => meter(c.category, c.score)).join("")}</div>
        </div>
        <div class="card">
          <h2 style="font-size:18px">What to do next</h2>
          <div style="margin-top:14px">
            ${insights("recommendation")
              .map(
                (item) => `<div style="margin-bottom:14px">
                  <b style="font-size:14.5px">${esc(item.label)}</b>
                  <p style="margin-top:4px;font-size:14px;color:var(--ink-soft)">${esc(item.detail || "")}</p>
                </div>`
              )
              .join("")}
          </div>
        </div>
      </div>

      <div class="grid grid-2" style="margin-top:18px">
        <div class="card">
          <h2 style="font-size:18px">What worked</h2>
          <ul style="margin-top:14px;padding-inline-start:18px;color:var(--ink-soft);font-size:14.5px">
            ${insights("strength").map((i) => `<li style="margin-bottom:8px"><b style="color:var(--ink)">${esc(i.label)}</b> - ${esc(i.detail || "")}</li>`).join("") || "<li>No answer scored above 75 this time.</li>"}
          </ul>
        </div>
        <div class="card">
          <h2 style="font-size:18px">What cost you</h2>
          <ul style="margin-top:14px;padding-inline-start:18px;color:var(--ink-soft);font-size:14.5px">
            ${insights("weakness").map((i) => `<li style="margin-bottom:8px"><b style="color:var(--ink)">${esc(i.label)}</b> - ${esc(i.detail || "")}</li>`).join("") || "<li>No single answer collapsed. Tighten the weakest category above.</li>"}
          </ul>
        </div>
      </div>

      ${
        flags.length
          ? `<div class="card" style="margin-top:18px">
              <h2 style="font-size:18px">Red flags, worst first</h2>
              <p style="margin-top:6px;font-size:14px;color:var(--ink-soft)">
                These are the patterns that refuse students whose facts were fine. Fix the high-risk ones before your next run.
              </p>
              <div style="margin-top:16px">
                ${flags
                  .map(
                    (f) => `<div class="flag">
                      ${severityPill(f.severity)}
                      <div><b>${esc(f.label)}</b><p>${esc(f.detail || "")}</p></div>
                    </div>`
                  )
                  .join("")}
              </div>
            </div>`
          : ""
      }

      <h2 style="font-size:21px;margin-top:36px">Answer by answer</h2>
      <div style="margin-top:16px">
        ${results.questions
          .filter((q) => q.answer)
          .map(
            (q) => `
          <article class="qa-block">
            <div class="spread">
              <span class="pill pill-brand">${esc(q.category)}</span>
              <div class="review-scores">
                <div><b class="score-${scoreClass(q.scores.answer)}">${q.scores.answer}</b> Answer</div>
                <div><b class="score-${scoreClass(q.scores.tone)}">${q.scores.tone}</b> Tone</div>
                <div><b class="score-${scoreClass(q.scores.clarity)}">${q.scores.clarity}</b> Clarity</div>
              </div>
            </div>
            <p style="margin-top:14px;font-family:var(--font-display);font-size:17px">${esc(q.question)}</p>
            <div class="qa-answer"><b style="font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)">You said</b>
              <p style="margin-top:6px">${esc(q.answer)}</p></div>
            <p style="margin-top:12px;font-size:14.5px;color:var(--ink-soft)"><b style="color:var(--ink)">Officer's note:</b> ${esc(q.feedback || "")}</p>

            <div class="coach-grid">
              <div class="coach-card"><h4>What to say</h4><p>${esc(q.whatToSay || "")}</p></div>
              <div class="coach-card"><h4>How to say it</h4><p>${esc(q.howToSayIt || "")}</p></div>
              <div class="coach-card"><h4>Why it works</h4><p>${esc(q.whyItWorks || "")}</p></div>
            </div>

            <div class="improved">
              <h4>Stronger version</h4>
              <p style="font-size:14.5px">${esc(q.improvedAnswer || "")}</p>
              <p class="muted" style="margin-top:8px">A framework, not a script. Say it in your own words - officers recognise memorised answers.</p>
            </div>
          </article>`
          )
          .join("")}
      </div>

      <div class="card spread" style="margin-top:22px">
        <div>
          <h2 style="font-size:18px">Run it again, harder</h2>
          <p style="margin-top:4px;font-size:14.5px;color:var(--ink-soft)">
            The score that matters is the one after you have fixed ${esc(results.categoryScores[0]?.category || "your weakest category")}.
          </p>
        </div>
        <div class="row">
          <a class="btn btn-primary" href="#/interview">New interview</a>
          <a class="btn btn-ghost" href="#/analytics">See progress</a>
        </div>
      </div>

      <p class="muted" style="margin-top:18px;line-height:1.6">
        Educational interview preparation only. This verdict describes your practice performance - it is not a
        prediction, and NIEC Visa AI cannot guarantee a visa outcome.
      </p>
    </div>`;
}

/* ---- coach ---- */

async function viewCoach() {
  if (!requireAuth()) return;
  renderLoading();
  const { entries } = await api("/api/custom-questions");

  const examples = [
    "How should I answer if my sponsor is my uncle and not my father?",
    "What do I say when the officer asks why I chose this university?",
    "How do I explain my two-year gap after graduation?",
    "What is the safest way to answer a question about OPT?",
    "How do I prove I will return home after my studies?",
  ];

  main().innerHTML = `
    <div class="shell page" style="max-width:820px">
      <div class="page-head">
        <p class="eyebrow">Coaching</p>
        <h1>Ask anything about your interview</h1>
        <p>This is not the officer - here the coach explains. Ask how to handle a question and you get an answer built
           from your own case file, plus the reasoning behind each part of it.</p>
      </div>

      <div class="card">
        <div class="field-group">
          <label class="label" for="questionBox">Your question</label>
          <textarea id="questionBox" rows="3" placeholder="How should I answer if the officer asks why my sponsor is my uncle?"></textarea>
        </div>
        <div class="row">
          ${examples.map((e) => `<button class="btn btn-ghost btn-sm example" type="button" data-q="${esc(e)}">${esc(e)}</button>`).join("")}
        </div>
        <div class="row" style="margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
          <button class="btn btn-primary" id="askBtn" type="button">Get a personalised answer</button>
          <span class="muted">Answers are built from your applicant profile.</span>
        </div>
      </div>

      <div id="answerSlot"></div>

      ${
        entries.length
          ? `<div class="card" style="margin-top:18px">
              <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint)">Your earlier questions</h2>
              <div style="margin-top:14px">${entries.map(coachEntryHtml).join("")}</div>
            </div>`
          : ""
      }
    </div>`;

  $$(".example").forEach((button) =>
    button.addEventListener("click", () => {
      $("#questionBox").value = button.dataset.q;
    })
  );

  $("#askBtn").addEventListener("click", async () => {
    const question = $("#questionBox").value.trim();
    if (question.length < 5) {
      toast("Ask a full question so the answer can be specific.", "error");
      return;
    }
    const button = $("#askBtn");
    setBusy(button, true, "Thinking...");
    try {
      const { entry } = await api("/api/custom-questions", { method: "POST", body: { question } });
      $("#answerSlot").innerHTML = `<div class="card" style="margin-top:18px">${coachEntryHtml(entry, true)}</div>`;
      $("#questionBox").value = "";
      setBusy(button, false);
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });
}

function coachEntryHtml(entry, expanded = false) {
  return `
    <div style="${expanded ? "" : "border-top:1px solid var(--line);padding-top:14px;margin-top:14px"}">
      <p class="muted" style="text-transform:uppercase;letter-spacing:.08em">${esc(entry.question)}</p>
      <p style="margin-top:10px;font-size:15px;line-height:1.7">${esc(entry.answer)}</p>
      ${
        expanded
          ? `<div class="coach-grid">
              <div class="coach-card"><h4>What to say</h4><p>${esc(entry.whatToSay || "")}</p></div>
              <div class="coach-card"><h4>How to say it</h4><p>${esc(entry.howToSayIt || "")}</p></div>
              <div class="coach-card"><h4>Why it works</h4><p>${esc(entry.whyItWorks || "")}</p></div>
            </div>
            ${entry.warning ? `<div class="alert alert-warn" style="margin-top:14px"><b>Avoid:</b> ${esc(entry.warning)}</div>` : ""}
            <p class="muted" style="margin-top:12px">Use this as a framework, not a script. A word-for-word delivery sounds rehearsed, and rehearsed is a red flag of its own.</p>`
          : ""
      }
    </div>`;
}

/* ---- resources ---- */

function viewResources() {
  main().innerHTML = `
    <div class="shell page">
      <div class="page-head">
        <p class="eyebrow">Resource library</p>
        <h1>Understand the interview before you rehearse it</h1>
        <p>Practical guides for students applying from high-scrutiny posts. No approval-rate claims, no scripts to memorise.</p>
      </div>
      <div class="grid grid-3">
        ${RESOURCES.map(
          (r) => `
          <a class="card resource-card" href="#/resources/${esc(r.slug)}">
            <div class="row" style="gap:10px">
              <span class="pill pill-accent">${esc(r.category)}</span>
              <span class="muted">${r.minutes} min read</span>
            </div>
            <h3>${esc(r.title)}</h3>
            <p>${esc(r.excerpt)}</p>
            <span style="margin-top:14px;font-size:14px;font-weight:600;color:var(--brand)">Read the guide</span>
          </a>`
        ).join("")}
      </div>
      <div class="card spread" style="margin-top:26px">
        <div>
          <h2 style="font-size:18px">Then find out what you actually sound like</h2>
          <p style="margin-top:4px;font-size:14.5px;color:var(--ink-soft)">Reading about the interview is the easy half.</p>
        </div>
        <a class="btn btn-primary" href="#/signup">Start a mock interview</a>
      </div>
    </div>`;
}

function viewResource(slug) {
  const guide = RESOURCES.find((r) => r.slug === slug);
  if (!guide) return viewNotFound();

  main().innerHTML = `
    <div class="shell page article" style="max-width:760px">
      <p><a href="#/resources">&larr; All guides</a></p>
      <div class="row" style="margin-top:16px;gap:10px">
        <span class="pill pill-accent">${esc(guide.category)}</span>
        <span class="muted">${guide.minutes} min read</span>
      </div>
      <h1 style="font-size:clamp(27px,4.4vw,38px);margin-top:12px">${esc(guide.title)}</h1>
      <p class="lede" style="margin-top:14px">${esc(guide.excerpt)}</p>

      ${guide.sections
        .map(
          (section) => `
        <section>
          <h2>${esc(section.h)}</h2>
          ${(section.p || []).map((p) => `<p>${esc(p)}</p>`).join("")}
          ${section.ul ? `<ul>${section.ul.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>` : ""}
        </section>`
        )
        .join("")}

      <div class="card spread" style="margin-top:34px">
        <div>
          <h2 style="font-size:18px">Try it against an officer</h2>
          <p style="margin-top:4px;font-size:14.5px;color:var(--ink-soft)">Ten minutes, one mock interview.</p>
        </div>
        <a class="btn btn-primary" href="${state.user ? "#/interview" : "#/signup"}">Start practising</a>
      </div>

      <p class="muted" style="margin-top:20px;line-height:1.6">
        Educational preparation only. Not legal or immigration advice, and not affiliated with the U.S. Department of State.
        Always check current requirements with the official embassy or consulate guidance for your post.
      </p>
    </div>`;
}

/* ---- notifications, settings, legal ---- */

async function viewNotifications() {
  if (!requireAuth()) return;
  renderLoading();
  const { notifications } = await api("/api/notifications");

  main().innerHTML = `
    <div class="shell page" style="max-width:760px">
      <div class="spread page-head">
        <div><h1>Notifications</h1><p>Interview results, security notices and account updates.</p></div>
        ${notifications.some((n) => !n.read) ? `<button class="btn btn-ghost btn-sm" id="readAll" type="button">Mark all read</button>` : ""}
      </div>
      ${
        notifications.length
          ? notifications
              .map(
                (n) => `<div class="notification${n.read ? "" : " unread"}">
                  <div class="spread">
                    <h3>${esc(n.title)}</h3>
                    <span class="muted">${formatDateTime(n.createdAt)}</span>
                  </div>
                  <p>${esc(n.body)}</p>
                </div>`
              )
              .join("")
          : `<div class="card empty">No notifications yet.</div>`
      }
    </div>`;

  $("#readAll")?.addEventListener("click", async () => {
    await api("/api/notifications/read", { method: "POST", body: { all: true } });
    await refreshUnread();
    viewNotifications();
  });

  // Opening the page marks everything read.
  if (notifications.some((n) => !n.read)) {
    await api("/api/notifications/read", { method: "POST", body: { all: true } });
    await refreshUnread();
  }
}

async function refreshUnread() {
  if (!state.token) return;
  try {
    const { unread } = await api("/api/notifications");
    state.unread = unread;
    renderChrome();
  } catch {
    /* the badge is not worth an error */
  }
}

async function viewSettings() {
  if (!requireAuth()) return;
  renderLoading();
  const { requests } = await api("/api/data-requests");
  const prefs = state.preferences;

  main().innerHTML = `
    <div class="shell page" style="max-width:820px">
      <div class="page-head">
        <h1>Settings and privacy</h1>
        <p>Signed in as ${esc(state.user.email)}${state.user.googleLinked ? " (Google linked)" : ""}.</p>
      </div>

      <section class="card" style="margin-bottom:18px">
        <h2 style="font-size:18px">Appearance</h2>
        <p style="margin-top:6px;font-size:14.5px;color:var(--ink-soft)">Choose how NIEC Visa AI looks on this device.</p>
        <div class="row" style="margin-top:14px">
          ${["light", "dark", "system"]
            .map(
              (option) =>
                `<button class="btn ${prefs.theme === option ? "btn-secondary" : "btn-ghost"} btn-sm theme-option" type="button" data-theme="${option}">${option}</button>`
            )
            .join("")}
        </div>
      </section>

      <section class="card" style="margin-bottom:18px">
        <h2 style="font-size:18px">Email preferences</h2>
        <label class="checkbox" style="margin-top:14px">
          <input type="checkbox" id="productEmails" ${prefs.productEmails ? "checked" : ""} />
          <span>Send me account and interview-result emails.</span>
        </label>
        <label class="checkbox" style="margin-top:12px">
          <input type="checkbox" id="marketingOptIn" ${prefs.marketingOptIn ? "checked" : ""} />
          <span>Send me NIEC study-abroad updates and offers (marketing).</span>
        </label>
        <div class="row" style="margin-top:16px">
          <button class="btn btn-primary btn-sm" id="savePrefs" type="button">Save preferences</button>
        </div>
      </section>

      <section class="card" style="margin-bottom:18px">
        <h2 style="font-size:18px">Your data</h2>
        <p style="margin-top:6px;font-size:14.5px;color:var(--ink-soft)">
          Your applicant profile, interview answers and coaching history are encrypted before they are stored. You can
          download everything held about your account, or ask NIEC to delete it.
        </p>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-ghost btn-sm" id="downloadData" type="button">Download my data</button>
          <button class="btn btn-ghost btn-sm" id="requestAccess" type="button">Request a formal data access report</button>
          <button class="btn btn-ghost btn-sm" id="requestDeletion" type="button">Request account deletion</button>
        </div>
        ${
          requests.length
            ? `<div style="margin-top:18px">
                <h3 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint)">Requests</h3>
                ${requests
                  .map(
                    (r) => `<div class="list-row" style="margin-top:10px">
                      <div><h3>${esc(r.kind === "access" ? "Data access" : "Account deletion")}</h3>
                      <p class="muted">${formatDateTime(r.createdAt)}</p></div>
                      <span class="pill pill-brand">${esc(r.status)}</span>
                    </div>`
                  )
                  .join("")}
              </div>`
            : ""
        }
      </section>

      <section class="card">
        <h2 style="font-size:18px">Account</h2>
        <div class="row" style="margin-top:14px">
          <a class="btn btn-ghost btn-sm" href="#/profile">Edit my case file</a>
          <a class="btn btn-ghost btn-sm" href="#/forgot">Change password</a>
          <button class="btn btn-danger btn-sm" id="signOutSettings" type="button">Sign out</button>
        </div>
      </section>
    </div>`;

  $$(".theme-option").forEach((button) =>
    button.addEventListener("click", async () => {
      const theme = button.dataset.theme;
      applyTheme(theme);
      state.preferences.theme = theme;
      await api("/api/preferences", { method: "PUT", body: { theme } });
      viewSettings();
    })
  );

  $("#savePrefs").addEventListener("click", async () => {
    const button = $("#savePrefs");
    setBusy(button, true, "Saving...");
    try {
      const { preferences } = await api("/api/preferences", {
        method: "PUT",
        body: { productEmails: $("#productEmails").checked, marketingOptIn: $("#marketingOptIn").checked },
      });
      state.preferences = preferences;
      toast("Preferences saved.", "success");
      setBusy(button, false);
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });

  $("#downloadData").addEventListener("click", async () => {
    try {
      const data = await api("/api/data-export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `niec-visa-ai-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast("Your data file has been downloaded.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  const makeRequest = async (kind) => {
    try {
      await api("/api/data-requests", { method: "POST", body: { kind } });
      toast(kind === "access" ? "Data access request logged." : "Deletion request logged. NIEC will confirm before removing anything.", "success");
      await refreshUnread();
      viewSettings();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  $("#requestAccess").addEventListener("click", () => makeRequest("access"));
  $("#requestDeletion").addEventListener("click", () => makeRequest("deletion"));
  $("#signOutSettings").addEventListener("click", signOut);
}

function legalPage(title, blocks) {
  main().innerHTML = `
    <div class="shell page article" style="max-width:760px">
      <h1 style="font-size:32px">${esc(title)}</h1>
      <p class="muted" style="margin-top:8px">Last updated ${formatDate(new Date().toISOString())}. This is a product
         template - NIEC should have it reviewed before public launch.</p>
      ${blocks.map(([h, ...ps]) => `<section><h2>${esc(h)}</h2>${ps.map((p) => `<p>${esc(p)}</p>`).join("")}</section>`).join("")}
    </div>`;
}

const viewPrivacy = () =>
  legalPage("Privacy policy", [
    ["What we collect", "Your name and email address, the applicant profile you enter, your interview answers and scores, the questions you ask the coach, and basic account preferences."],
    ["How it is protected", "Your applicant profile, interview answers and coaching history are encrypted with AES-256-GCM before they are written to the database. Passwords are stored as scrypt hashes, never in plain text. Session and password-reset tokens are stored only as hashes."],
    ["What we never ask for", "Do not enter passport numbers, bank account numbers, or any document identifier. The practice does not need them, and this product does not store them."],
    ["AI processing", "When an external AI provider is configured by the operator of this installation, the text of your applicant profile and answers is sent to that provider to generate questions and coaching. Without a provider key, everything is processed locally by the built-in engine and nothing leaves the server."],
    ["Your rights", "You can download everything held about your account from Settings at any time, and you can request formal data access or account deletion from the same page."],
    ["Contact", "Direct privacy questions to NIEC through the contact details on the main NIEC website."],
  ]);

const viewTerms = () =>
  legalPage("Terms of use", [
    ["What this service is", "NIEC Visa AI is an educational interview practice tool. It simulates a U.S. consular officer so you can rehearse and improve your answers."],
    ["What it is not", "It is not legal advice, not immigration advice, and not affiliated with the U.S. Department of State or any government body. No score, verdict or feedback here predicts or guarantees the outcome of a real visa application."],
    ["Honest use", "Feedback and improved answers are frameworks to adapt in your own words. Do not use this service to prepare false or misleading statements for a consular officer. Misrepresentation to a visa officer carries serious, permanent consequences."],
    ["Your content", "You keep ownership of everything you enter. You grant NIEC permission to process it solely to operate this service for you."],
    ["Availability", "The service is provided as-is. Practice sessions and reports may be unavailable during maintenance."],
  ]);

function viewNotFound() {
  main().innerHTML = `
    <div class="shell page" style="text-align:center;padding-top:80px">
      <p style="font-family:var(--font-display);font-size:60px;color:var(--brand)">404</p>
      <h1 style="margin-top:10px">This page is not in the file.</h1>
      <p style="margin-top:10px;color:var(--ink-soft)">The page you were looking for does not exist.</p>
      <div class="row" style="justify-content:center;margin-top:24px">
        <a class="btn btn-primary" href="#/">Back to the homepage</a>
        <a class="btn btn-ghost" href="#/dashboard">Go to dashboard</a>
      </div>
    </div>`;
}

/* ------------------------------------------------------- 7. router + boot */

function requireAuth() {
  if (state.user) return true;
  toast("Please sign in to continue.");
  location.hash = "#/login";
  return false;
}

const ROUTES = [
  [/^\/?$/, viewLanding],
  [/^\/login$/, viewLogin],
  [/^\/signup$/, viewSignup],
  [/^\/forgot$/, viewForgot],
  [/^\/reset$/, (m, query) => viewReset(query)],
  [/^\/onboarding$/, viewOnboarding],
  [/^\/profile$/, viewProfile],
  [/^\/dashboard$/, viewDashboard],
  [/^\/interview$/, viewInterviewSetup],
  [/^\/interview\/([\w-]+)$/, (m) => viewInterviewRun(m[1])],
  [/^\/results\/([\w-]+)$/, (m) => viewResults(m[1])],
  [/^\/history$/, viewHistory],
  [/^\/analytics$/, viewAnalytics],
  [/^\/coach$/, viewCoach],
  [/^\/resources$/, viewResources],
  [/^\/resources\/([\w-]+)$/, (m) => viewResource(m[1])],
  [/^\/notifications$/, viewNotifications],
  [/^\/settings$/, viewSettings],
  [/^\/privacy$/, viewPrivacy],
  [/^\/terms$/, viewTerms],
];

async function router() {
  closeMobileNav();
  stopListening();
  stopSpeaking();

  const raw = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const query = new URLSearchParams(queryPart || "");

  // "#/#how" style links on the landing page: render home, then scroll.
  const anchor = pathPart.includes("#") ? pathPart.split("#")[1] : null;
  const path = anchor ? "/" : pathPart;

  renderChrome();

  const route = ROUTES.find(([pattern]) => pattern.test(path));
  try {
    if (route) await route[1](path.match(route[0]), query);
    else viewNotFound();
  } catch (error) {
    console.error(error);
    main().innerHTML = `<div class="shell page"><div class="alert alert-error">${esc(error.message || "Something went wrong.")}</div>
      <a class="btn btn-ghost" href="#/dashboard">Back to dashboard</a></div>`;
  }

  if (anchor) {
    setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth" }), 60);
  } else {
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  main().focus({ preventScroll: true });
}

/**
 * Report browser errors to the server.
 *
 * Without this, a JavaScript error on a student's phone is invisible: the page
 * half-breaks and nobody ever hears about it. Reports are capped per page load
 * and deduplicated, so one error in a render loop cannot flood the log. Only
 * the error itself is sent - never answers, profile fields or the token.
 */
function installErrorReporting() {
  const seen = new Set();
  let sent = 0;
  const MAX_PER_PAGE = 5;

  const report = (details) => {
    const fingerprint = `${details.message}|${details.line}`;
    if (sent >= MAX_PER_PAGE || seen.has(fingerprint)) return;
    seen.add(fingerprint);
    sent += 1;

    // keepalive lets the report survive the page being closed straight after.
    fetch(`${API_BASE}/api/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...details, page: location.hash || "#/" }),
      keepalive: true,
    }).catch(() => {
      /* if the server is unreachable there is nothing useful left to do */
    });
  };

  window.addEventListener("error", (event) => {
    report({
      message: String(event.message || "script error"),
      source: String(event.filename || ""),
      line: event.lineno || null,
      column: event.colno || null,
      stack: event.error?.stack ? String(event.error.stack) : "",
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    report({
      message: `unhandled promise rejection: ${reason?.message ?? String(reason)}`,
      source: "",
      line: null,
      column: null,
      stack: reason?.stack ? String(reason.stack) : "",
    });
  });
}

async function boot() {
  installErrorReporting();
  $("#year").textContent = String(new Date().getFullYear());
  applyTheme(localStorage.getItem(THEME_KEY) || "light", { persist: false });

  $("#themeToggle").addEventListener("click", toggleTheme);
  $("#menuToggle").addEventListener("click", () => {
    const nav = $("#mobileNav");
    const open = nav.dataset.open !== "true";
    nav.dataset.open = String(open);
    nav.hidden = !open;
    $("#menuToggle").setAttribute("aria-expanded", String(open));
  });

  try {
    state.serverConfig = await api("/api/config");
  } catch {
    toast("Cannot reach the NIEC Visa AI server. Start the backend and refresh.", "error");
  }

  await loadSession();
  renderChrome();
  window.addEventListener("hashchange", router);
  await router();
}

boot();
