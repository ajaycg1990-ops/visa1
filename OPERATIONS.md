# Running NIEC Visa AI in production

What to do when something breaks, and how to keep it from breaking silently.

---

## The one rule

**Never edit code on the hosted server.**

Fix it on your computer, test it, commit it, then deploy. The moment you edit
the server directly, nobody knows what is actually running, and your next
deploy silently wipes the fix.

---

## When something breaks

### 1. See what happened

```bash
node scripts/logs.mjs --errors        # every error from the last 7 days
node scripts/logs.mjs --errors --full # with complete stack traces
node scripts/logs.mjs --grep interview
node scripts/logs.mjs --lines 200     # more history
```

Logs are written to `logs/app-YYYY-MM-DD.log`, one JSON object per line, kept
for 30 days.

**If a student reports an error**, ask them for the reference code. Every 500
error shows them something like *"(Reference 7K2P9Q)"*, and that exact code is
in the log next to the stack trace, the route, and their user id:

```bash
node scripts/logs.mjs --errors --grep 7K2P9Q --full
```

### 2. Reproduce it locally

Get the app running on your computer (`node start.mjs`) and make the same thing
happen. A bug you cannot reproduce is a bug you cannot confirm you fixed.

If it only happens with real data, restore a backup into your local
`database/niec.sqlite` and try again.

### 3. Fix, then prove it

```bash
node tests/e2e.mjs
```

57 checks across the whole journey. **If this fails, do not deploy.** It is the
difference between fixing one bug and shipping two.

### 4. Ship it

```bash
git add -A
git commit -m "fix: describe what was wrong"
git push
```

Then on the server: pull, and restart.

### 5. If the fix made things worse

```bash
git log --oneline      # find the last good commit
git revert HEAD        # undo the most recent commit safely
```

Back to working in seconds. This is why git matters more than any other item
on this page.

---

## What is watching things for you

| Protection | What it does |
| --- | --- |
| **File logging** | Every request, warning and error, kept 30 days in `logs/` |
| **Reference codes** | Ties a student's complaint to an exact stack trace |
| **Browser error capture** | JavaScript errors on the student's device are POSTed to `/api/client-error` and logged. Capped at 5 per page load, deduplicated. |
| **Crash auto-restart** | A crashed server restarts after 1s, 2s, 4s… If it crashes 5 times in a minute, it stops and tells you to read the log — because that is a real bug, not a blip. |
| **AI fallback** | If OpenAI is down, slow or the key expires, the built-in engine takes over. Students never see a failure. |
| **Rate limiting** | Per-IP caps on auth, AI and general traffic |

### What is NOT watching

Nothing emails or messages you when an error happens. You have to look. Once
there are real students, add an alerting service (Sentry, Better Stack, or
your host's own alerts) — `logger.error` in `backend/src/logger.mjs` is the
single place to hook it in.

---

## Backups

```bash
node scripts/backup.mjs
```

Writes a consistent copy to `backups/` — safe to run while the server is live —
and keeps the newest 14.

**Schedule it daily.**

- **Windows**: Task Scheduler → Create Basic Task → Daily → Start a program →
  `node` with arguments `scripts\backup.mjs`, "Start in" set to the project folder.
- **Linux**: `crontab -e`, then
  `0 3 * * * cd /path/to/NIEC-VISA-AI && /usr/bin/node scripts/backup.mjs`

### Two things that make backups worthless

1. **Backups stored only on the same server.** Copy them off it — another disk,
   cloud storage, anywhere else.
2. **Losing `DATA_ENCRYPTION_KEY`.** Student data inside every backup is
   encrypted with it. Lose the key and the backups are unreadable — by you, by
   me, by anybody. Store it somewhere separate and safe.

### Restoring

```bash
# stop the app first
copy backups\niec-2026-09-23T02-15-34.sqlite database\niec.sqlite
# start it again
```

**Test this once before you need it.** A backup you have never restored is a
guess, not a backup.

---

## Before you host: the checklist

- [ ] **Rotate the OpenAI key** and set a monthly spend limit at platform.openai.com
- [ ] **Uncomment `DATA_ENCRYPTION_KEY`** in `.env` — and delete the demo
      database first, since it was written with the development key
- [ ] **Store both secrets** somewhere safe and separate from the server
- [ ] **Set `NODE_ENV=production`** (this refuses to boot on development secrets)
- [ ] **Put HTTPS in front** — Caddy, nginx, or your host's built-in TLS
- [ ] **Update `CORS_ORIGINS` and `PUBLIC_APP_URL`** to your real domain
- [ ] **Schedule the backup** and copy backups off the machine
- [ ] **Run `node tests/e2e.mjs`** on the server after the first deploy
- [ ] **Push the git repo** to GitHub or GitLab (private), so the code survives
      the laptop

### A note on scale

SQLite is one file on one machine. That is genuinely fine for hundreds of
students on a single server. It does **not** work if you run two servers behind
a load balancer — at that point move to PostgreSQL, which means rewriting
`backend/src/db.mjs` and nothing else.

---

## Common problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Site loads, everything fails | API is down | `node scripts/logs.mjs --errors`; check the process is running |
| "Cannot reach the server" toast | Wrong `PUBLIC_API_URL`, or CORS blocking the domain | Fix `.env`, restart |
| Interviews are generic | Key missing/invalid — silently fell back | `/health` should say `"engine":"provider"` |
| OpenAI bill climbing | Someone running many interviews, or a retry loop | Spend limit at OpenAI; lower `RATE_LIMIT_AI` |
| Blank profile fields after a change | `DATA_ENCRYPTION_KEY` was changed | Restore the old key — nothing else recovers it |
| Slow interviews | The model is slow | Lower `AI_TIMEOUT_MS`; it falls back to built-in |
