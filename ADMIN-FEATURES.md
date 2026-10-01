# NIEC Visa AI — Admin Portal

Feature list for quotation and scope documents.

Everything below is **built, tested and working**, not planned. The access
control and privacy claims are covered by automated tests that fail the build
if they ever stop being true.

---

## 1. Separate admin portal

| Feature | Detail |
| --- | --- |
| A separate app | Its own address (`/admin/`), its own pages and its own session - only admin features, nothing from the student site |
| Dedicated staff sign-in | Staff sign in at `/admin/`; the student site has no admin links, and old links redirect here |
| Hidden from search engines | Marked no-index, so it never shows up in Google |
| Works on a phone | Sidebar on a computer, a compact top bar on a phone |
| Needs-attention list | The overview opens with what to act on: open data requests, launch blockers, server errors, an empty question bank |
| Staff-only authentication | A valid student account is refused here, even with the correct password |
| No account discovery | Wrong password, unknown email and valid-student all return an identical message, so the portal cannot be used to find out which addresses belong to staff |
| Brute-force protection | Shares the strict authentication rate limit (30 attempts per IP per 15 minutes) |
| No self-service access | No page anywhere grants admin rights; a stolen student session cannot escalate itself |
| Attempt logging | Every staff sign-in and every refused attempt is written to the audit log with the account and IP |

## 2. Access control

| Feature | Detail |
| --- | --- |
| Role-based permissions | Two roles: `student` and `admin`, enforced on every admin endpoint |
| Server-side admin creation | Admins are promoted from the server console (`make-admin`), never through the web |
| Hidden, not just blocked | A signed-in student receives "not found" rather than "forbidden", so the admin area does not reveal that it exists |
| Navigation isolation | The Admin link is rendered only for admin accounts |
| Promote and demote | Access can be granted or withdrawn at any time from one command |
| Admin register | List every account that currently holds admin rights |

## 3. Usage dashboard

| Feature | Detail |
| --- | --- |
| Headline figures | Total students, total interviews, completed interviews, interviews in progress |
| Weekly activity | New sign-ups and interviews taken in the last 7 days |
| Score summary | Average, lowest and highest interview score across all students |
| Verdict breakdown | How many interviews ended Likely approved / Borderline / Likely refused |
| Officer popularity | Which interview styles students actually choose — strict, neutral, casual |
| Coaching usage | Number of questions asked of the AI coach |
| AI status | Which engine is live (built-in or AI provider) and which model |

## 4. Teaching insight

| Feature | Detail |
| --- | --- |
| Weakest categories, all students | Average score per category across the whole cohort, ranked worst first |
| Sample sizes | How many interviews each category average is based on |
| Practical use | Shows NIEC which topics to teach in person — e.g. if Financial Readiness averages 58 across 200 students, that is a counselling priority, not an individual problem |

## 5. Account management

| Feature | Detail |
| --- | --- |
| Account register | Every account with name, email and role |
| Sign-up date | When each account was created |
| Engagement | Interviews started and completed, per account |
| Performance | Each student's average score |
| Last activity | Date of their most recent interview |
| Profile status | Whether the student has completed an applicant profile |
| Coaching usage | Number of coach questions asked per account |
| Support lookup | Enough detail to answer "has this student actually used it?" without reading anything they wrote |

## 6. Interview question bank

| Feature | Detail |
| --- | --- |
| Upload questions | Load Word (.docx), Excel (.xlsx), CSV or text files - or drag them onto the page, or paste - hundreds of questions at once |
| Check before saving | A preview lists every question with its category and topic, marks those already in the bank, and explains every line left out |
| Automatic sorting | Each question is sorted into an interview topic (sponsor, plans after graduation, gap years, OPT, ...) and a category, so staff-written wording replaces the built-in one |
| Reads real documents | Section headings file the questions below them; numbering, bullets, column titles and sample answers are recognised and left out; a category can also be given per line (`Financial \| ...` or `[Intent] ...`) |
| Personalised wording | `{university}`, `{program}` and `{homeCountry}` are filled from each student's own file |
| Duplicate protection | Questions already in the bank are skipped, so the same file can be uploaded twice safely |
| Relevance rules | Questions about a loan, a refusal or a gap are only asked when the student's file has one |
| Switch off or delete | Pause a question without losing it, or remove it; past interviews keep their questions |
| Search and counts | Search the bank; see how many active questions each category has |
| Live question choice | The officer picks each question after hearing the previous answer and follows up on what the student said |

## 7. System health

| Feature | Detail |
| --- | --- |
| Launch readiness | Every pre-launch check on one screen - secrets, domain, HTTPS, database key, backups, git, AI - each marked ok, warning or blocker with what to do |
| Server errors | The last week's errors with the reference code a student was shown, so a complaint can be matched to the exact problem |
| Backups | How many are kept and how old the newest is |
| Server status | AI engine and model in use, mode, uptime |
| Safe key change | `scripts/rotate-key.mjs` replaces the data encryption key and re-encrypts every record in one step, with a backup first |

## 8. Privacy and compliance

| Feature | Detail |
| --- | --- |
| Aggregate-only access | No admin screen or endpoint can read a student's interview answers, applicant profile, financial details or coaching history |
| Enforced, not promised | An automated test scans every admin response for known answer text and fails the build if any appears |
| Data request queue | Every data access and deletion request from every student, in one list |
| Request handling | Mark a request actioned, with the completing administrator recorded in the log |
| Outstanding alerts | Open requests are flagged at the top of the dashboard, since these carry legal deadlines |
| Encryption at rest | Student profiles, answers and coaching text are AES-256-GCM encrypted in the database, readable only by the student's own account |

## 9. Operations tooling

Not part of the admin web portal, but delivered with it and usually quoted
alongside:

| Feature | Detail |
| --- | --- |
| Error log reader | Search and filter all errors with full stack traces |
| Support reference codes | Every error shows the student a short code that maps to the exact log entry, so "it didn't work" becomes a one-command lookup |
| Browser error capture | JavaScript errors on a student's own device are reported back and logged |
| Automatic crash recovery | A crashed server restarts itself with backoff, and stops with a clear message if the fault is persistent |
| Database backup | One command for a consistent backup, safe to run while the system is live, with automatic pruning |
| Pre-launch check | Validates configuration before go-live and blocks launch on unsafe settings |
| Deployment package | HTTPS configuration, service definition, scheduled backups and a step-by-step hosting guide |

---

## Suggested quotation wording

> **Admin Portal — NIEC Visa AI**
>
> A separate, secure admin portal - its own address, sign-in and session -
> providing NIEC with full operational visibility of the student visa
> interview platform.
>
> Includes a dedicated staff sign-in with role-based access control; a usage
> dashboard covering student numbers, interview volume, completion rates and
> score distribution; cohort-level teaching insight showing which interview
> categories students across the board struggle with; an account register with
> per-student engagement and performance; an interview question bank where
> staff upload and manage hundreds of questions, sorted into topics
> automatically and asked live by the simulated officer; and a data request
> queue for handling access and deletion requests.
>
> Built to a strict privacy standard: administrators see activity and scores,
> never the content of a student's answers or financial details. This boundary
> is enforced by automated tests.
>
> Delivered with operational tooling: error logging with support reference
> codes, automatic crash recovery, scheduled database backups, a pre-launch
> configuration check, and a complete deployment package.

---

## What is not included

State these as exclusions, or price them as a later phase:

- **Editing AI prompts from the portal.** Same — code, not screen.
- **Automated account deletion.** Requests are queued and tracked; the deletion
  itself is performed manually.
- **Email alerts to staff.** Errors are logged, not pushed. Nobody is notified
  automatically.
- **Exporting reports to CSV or PDF.**
- **Multiple admin permission levels.** There is one admin role, not a hierarchy
  of counsellor / manager / owner.
- **Reading a student's answers**, even with consent. If NIEC wants counsellors
  to review individual interviews, that is a separate feature with its own
  privacy decision, consent flow and policy update.
