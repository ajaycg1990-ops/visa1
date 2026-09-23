# Hosting NIEC Visa AI on a VPS

From a blank server to a live site on your own domain. About an hour, mostly
waiting. Costs roughly $5/month.

Everything below assumes Ubuntu 24.04. Commands starting with `local$` run on
your Windows machine; `server$` run on the VPS over SSH.

---

## Before you start

Three things this guide assumes you have:

1. **A domain** you control, e.g. `visa.niec.edu.np`
2. **A VPS** — Hetzner CX22 (~€4), DigitalOcean, Vultr, Linode. The smallest
   tier is genuinely enough for hundreds of students.
3. **A fresh OpenAI key.** The one currently in `.env` was pasted into a chat
   window; revoke it at platform.openai.com and create a new one. Set a monthly
   spend limit on it while you are there.

**Why a VPS and not Vercel or Netlify:** this app stores everything in a SQLite
file on disk. Serverless platforms wipe the filesystem on every deploy, which
would delete every account and interview. Any host that gives you a persistent
disk works; those two do not.

---

## 1. Push your code somewhere

Your four commits exist only on your laptop. Create a **private** repository on
GitHub, then:

```
local$ cd "C:\Users\Acer\Downloads\KOCK TEST BEGINS\NIEC-VISA-AI"
local$ git remote add origin git@github.com:YOUR-USER/niec-visa-ai.git
local$ git push -u origin master
```

`.env` is git-ignored, so your keys stay off GitHub. Confirm that before
pushing:

```
local$ git ls-files | findstr .env
```

You should see `.env.example` and nothing else.

---

## 2. Point the domain at the server

In your DNS provider, add an **A record**:

| Type | Name | Value |
| --- | --- | --- |
| A | `visa` | your VPS IP address |

Wait for it to resolve before step 5 — Caddy cannot get a certificate until the
domain points at the server.

```
local$ nslookup visa.niec.edu.np
```

---

## 3. Prepare the server

SSH in as root, then:

```
server$ apt update && apt upgrade -y

# Node 22+ (Ubuntu's default is too old for node:sqlite)
server$ curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
server$ apt install -y nodejs git
server$ node -v          # must be 22.5 or newer

# A user for the app, so it never runs as root
server$ adduser --system --group --home /opt/niec-visa-ai niec

# Firewall: only SSH and web. Ports 3000 and 4000 stay private.
server$ ufw allow OpenSSH
server$ ufw allow 80,443/tcp
server$ ufw --force enable
```

---

## 4. Install the app

```
server$ git clone https://github.com/YOUR-USER/niec-visa-ai.git /opt/niec-visa-ai
server$ cd /opt/niec-visa-ai
server$ chown -R niec:niec /opt/niec-visa-ai
```

Create the production `.env`:

```
server$ cp .env.example .env
server$ nano .env
```

Set these, and generate the two secrets with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`:

```
NODE_ENV=production
SESSION_SECRET=<generated>
DATA_ENCRYPTION_KEY=<generated>

PUBLIC_APP_URL=https://visa.niec.edu.np
PUBLIC_API_URL=https://visa.niec.edu.np
CORS_ORIGINS=https://visa.niec.edu.np

AI_API_KEY=<your new key>
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini

SEED_DEMO=0
```

Then lock the file down — it holds your keys:

```
server$ chmod 600 .env && chown niec:niec .env
```

> **`DATA_ENCRYPTION_KEY` can be set once and never again.** Every student
> profile and answer is encrypted with it. Change it later and all existing
> data becomes permanently unreadable. Write it down somewhere safe and
> separate from the server, today.

Note `PUBLIC_API_URL` is the same domain as the app: Caddy routes `/api/*` to
the backend, so the browser only ever talks to one origin and CORS never
applies.

---

## 5. HTTPS

```
server$ apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
server$ curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
server$ curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
server$ apt update && apt install -y caddy

server$ cp /opt/niec-visa-ai/deploy/Caddyfile /etc/caddy/Caddyfile
server$ nano /etc/caddy/Caddyfile      # replace visa.niec.edu.np with your domain
server$ systemctl reload caddy
```

Caddy fetches and renews the certificate on its own. Nothing else to do.

---

## 6. Start the app

```
server$ cp /opt/niec-visa-ai/deploy/niec-visa-ai.service /etc/systemd/system/
server$ systemctl daemon-reload
server$ systemctl enable --now niec-visa-ai
server$ systemctl status niec-visa-ai
```

---

## 7. Check it before telling anyone

```
server$ cd /opt/niec-visa-ai
server$ sudo -u niec node scripts/preflight.mjs
```

**Every FAIL must be green before you share the link.** It catches the silent
mistakes: development encryption key, localhost domain, missing HTTPS, secrets
exposed to git.

Then the real test, from your own phone — not the server:

- [ ] `https://visa.niec.edu.np` loads with a padlock
- [ ] Create a test account and complete the profile
- [ ] Run a full interview **using the microphone** (this is the one thing that
      cannot be tested from a terminal, and the one thing HTTPS is required for)
- [ ] Read the report, ask the coach a question
- [ ] `https://visa.niec.edu.np/health` shows `"engine":"provider"`

---

## 8. Backups, before the first real student

```
server$ sudo -u niec node scripts/backup.mjs     # prove it works
server$ crontab -u niec -e                        # paste deploy/backup.cron
```

Then copy backups off the server as well. A backup on the same disk as the
database protects you from mistakes, not from losing the machine.

---

## Updating after this

Never edit code on the server. Fix locally, then:

```
local$  git add -A && git commit -m "fix: whatever it was" && git push
server$ cd /opt/niec-visa-ai && sudo -u niec git pull
server$ sudo -u niec node tests/e2e.mjs      # 57 checks, on the server
server$ systemctl restart niec-visa-ai
```

If an update breaks something:

```
server$ sudo -u niec git revert HEAD && systemctl restart niec-visa-ai
```

---

## When something goes wrong

```
server$ systemctl status niec-visa-ai            # is it running?
server$ journalctl -u niec-visa-ai -n 50         # what systemd saw
server$ sudo -u niec node scripts/logs.mjs --errors --full
server$ systemctl status caddy                   # HTTPS problems
```

A student reporting an error will have a reference code on screen:

```
server$ sudo -u niec node scripts/logs.mjs --errors --grep 7K2P9Q --full
```

[OPERATIONS.md](OPERATIONS.md) has the full troubleshooting table.

---

## What this setup does and does not do

**Handles:** HTTPS with auto-renewal, restart on crash, restart on reboot, logs
you can search, daily backups, a firewall, the app running unprivileged and
reachable only through the proxy.

**Does not handle:**

- **Alerting.** Nothing tells you when an error happens; you have to look. Add
  Sentry or your host's monitoring when real students arrive.
- **Scaling past one machine.** SQLite is one file on one disk. For a second
  server you need PostgreSQL, which means rewriting `backend/src/db.mjs` and
  nothing else.
- **Legal review.** The privacy policy and terms are templates, and deletion
  requests are recorded but not carried out. Settle both before students enter
  real financial details.
