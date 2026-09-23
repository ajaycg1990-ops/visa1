# NIEC Visa AI

An AI visa-interview practice platform in NIEC brand: a simulated U.S. consular
officer that interviews the student about **their own case**, scores every
answer, flags the things that quietly cause refusals, and coaches a stronger
answer.

**No `npm install`. No Docker. No Postgres.** It runs on Node's built-in SQLite.

```bash
node start.mjs          # or: start.bat (Windows) / ./start.sh (macOS, Linux)
```

| | |
| --- | --- |
| Website | http://localhost:3000 |
| API | http://localhost:4000 |
| Health check | http://localhost:4000/health |
| Demo account | `student@example.com` / `Demo123!` |

Requires **Node 20 or newer**. SQLite is provided by `better-sqlite3` for wider hosting compatibility.

---

## What works

**Interview**
- Mock F-1 student visa interviews with a simulated consular officer
- Strict / Neutral / Casual officer styles - each changes questioning behaviour, follow-up aggression and marking, not just wording
- 10 adaptive questions drawn from the student's own file: a refusal, a funding gap, a loan or a gap year each pull in their own question
- Live follow-up drills when an answer is thin, vague or hedged, kept on-topic and capped so the interview stays 10 questions
- Voice in (browser `SpeechRecognition`) and voice out (`speechSynthesis`), with typing always available

**Scoring and feedback**
- Instant per-answer scoring on **Answer**, **Tone** and **Clarity**
- Category scoring across Academic & Programme, Financial Readiness, Intent to Return, Personal & History, Composure Under Pressure
- Strengths, weaknesses, ranked red flags and next-step recommendations
- Red-flag detection: sponsor contradiction against the stored file, immigration-intent language, funding that depends on U.S. work, concealed refusal, undocumented loan, funding shortfall arithmetic, vagueness, rehearsed phrasing
- Improved answers built from the student's real numbers, with **What To Say / How To Say It / Why It Works**

**Coaching and content**
- Custom interview Q&A: ask anything, get a personalised answer plus the framework behind it, with history saved
- Resource library: student visa guide, interview tips, common mistakes, documents checklist, red flags, interview day, and a business-visa overview

**Account and platform**
- Email/password sign-up and login, optional Google sign-in, forgot/reset password
- Applicant profile with completeness tracking; saved interview history and analytics with a readiness score
- Notifications, light/dark appearance, marketing opt-out, data-access and deletion requests, one-click data download
- Encryption at rest for sensitive text, scrypt password hashing, signed expiring sessions, CORS allow-list, rate limiting, security headers

## Layout

```
NIEC-VISA-AI/
├── start.mjs · start.bat · start.sh   launchers (run both servers)
├── .env.example                       configuration template
├── backend/
│   ├── schema.sql                     copy of the schema
│   └── src/
│       ├── server.mjs                 HTTP API, routing, auth gates, rate limits, CORS
│       ├── db.mjs                     SQLite layer, persistence, notifications, demo seed
│       ├── ai.mjs                     question generation, scoring, coaching, custom Q&A
│       ├── security.mjs               scrypt, signed tokens, AES-256-GCM, token hashing
│       └── config.mjs                 .env loading and configuration
├── frontend/
│   ├── index.html                     application shell
│   ├── styles.css                     full design system, light/dark, responsive
│   ├── app.js                         all screens, routing, interview UI, voice, analytics
│   ├── server.mjs                     static server + runtime API config
│   └── assets/                        NIEC logo
├── database/schema.sql                complete schema (applied on first start)
└── tests/e2e.mjs                      full API journey against a throwaway database
```

The runtime database is created automatically at `database/niec.sqlite`.

## Running it in production

See **[OPERATIONS.md](OPERATIONS.md)** - how to read the logs, diagnose a bug a
student reports, back up and restore the database, and the checklist to work
through before hosting.

```bash
node scripts/logs.mjs --errors   # what went wrong, with stack traces
node scripts/backup.mjs          # consistent backup, safe while running
```

Logs go to `logs/`, backups to `backups/`; both are git-ignored. A crashed
server restarts itself, and browser errors on a student's device are reported
back and logged.

## Test

```bash
node tests/e2e.mjs
```

Starts a real backend against a temporary database and walks the whole journey:
register → save profile → start mock → answer every question → finish and score
→ read results → analytics → custom Q&A → notifications → preferences → data
access request → forgot password → reset password → sign in with the new
password. It also asserts that red flags fire on bad answers, that a weak
interview scores below a strong one, and that one student cannot read another's
interview. **57 checks; nothing is mocked.**

## The two engines

Everything works with **no AI key**. The built-in engine selects and adapts
questions from a bank of 24 (each with the intent it tests, keywords for a
specific answer, and follow-up drills), scores answers with transparent
heuristics, and writes coaching from the applicant's own file.

Set an OpenAI-compatible provider and it takes over question generation and
coaching text:

```
AI_API_KEY=...
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=your-model-name
```

Every provider call is validated and falls back to the built-in engine on
failure, so an outage degrades quality, never uptime. **Numeric scoring stays
deterministic in both modes** - scores are compared across sessions in
analytics, so they must not drift with model temperature.

## Configuration

Copy `.env.example` to `.env`. Everything is optional locally; two values are
mandatory before deployment:

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs session and reset tokens |
| `DATA_ENCRYPTION_KEY` | Encrypts applicant data at rest. **Set once, before real data exists** - changing it makes existing rows unreadable |
| `GOOGLE_CLIENT_ID` | Enables "Sign in with Google" |
| `RESEND_API_KEY` + `FROM_EMAIL` | Sends real password-reset email |
| `AI_*` | Optional provider (above) |
| `CORS_ORIGINS` | Browser origins allowed to call the API |
| `SEED_DEMO=0` | Skip the demo student on a fresh database |

Starting with `NODE_ENV=production` while the two secrets are still at their
development defaults **refuses to boot**, by design.

Without an email provider, password reset still works end to end: the reset
link is returned to the browser in development instead of being emailed.

## Security

- **Passwords**: scrypt with a per-user salt. Never stored or logged in plain text.
- **Sessions and reset links**: random tokens, HMAC-signed, stored only as SHA-256 hashes, so a database copy cannot be replayed as a login. Reset tokens are single-use, expire in an hour, and invalidate every other session when used.
- **Encryption at rest**: AES-256-GCM on the applicant profile, interview questions and answers, coaching text and custom Q&A.
- **Access control**: every interview, report and export is scoped to its owner; the e2e suite asserts one student cannot read another's.
- **Transport and headers**: CORS allow-list, CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS in production.
- **Rate limiting**: separate buckets for auth, AI and general traffic.
- **Data minimisation**: students are told not to enter passport or bank account numbers, and no such field exists.

## Honesty constraints built into the product

- No approval-rate claims and no "say this and you will be approved".
- Every report carries the disclaimer: educational preparation only, not legal or immigration advice, not affiliated with the U.S. Department of State, no guaranteed outcome.
- Improved answers are always framed as frameworks to adapt, never scripts to memorise - a rehearsed delivery is itself a red flag, and the product scores it as one.
- The terms page explicitly forbids using the tool to prepare misleading statements for a consular officer.

## Before public launch

This is a working build, not a finished deployment. Still needed:

1. **Legal review** of the privacy policy and terms templates in `app.js`, plus the data-processing terms of any AI provider you enable.
2. **Retention policy** - decide how long interview transcripts are kept, and implement automatic deletion. Deletion requests are currently logged and notified, not executed.
3. **PostgreSQL** if you run more than one server. SQLite is single-node; `db.mjs` is the only file that needs rewriting.
4. **Real email delivery** for password resets, and email verification at sign-up.
5. **HTTPS and secrets management** - both secrets in a secret store, not in `.env` on the box.
6. **Backups** of the database and a tested restore, since encrypted data is unrecoverable without `DATA_ENCRYPTION_KEY`.
