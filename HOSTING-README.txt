NIEC VISA AI - FREE HOSTING COMPATIBLE TEST BUILD

Requirements:
- Node.js 20 or newer
- Build/install command: npm install
- Start command: npm start
- Public port: supplied automatically through PORT

Environment variables:
AI_API_KEY=your OpenAI API key (optional for built-in test mode)
SESSION_SECRET=a long random secret (16+ chars)
DATA_ENCRYPTION_KEY=a long random secret (keep unchanged for existing encrypted data)
RESEND_API_KEY=optional
NODE_ENV=development (recommended for initial testing)
LOG_TO_FILE=0

Changes in this build:
- Replaced Node 22.5-only node:sqlite with better-sqlite3.
- Supports Node.js 20+.
- Frontend and API are exposed through one public PORT.
- API remains private internally and is reverse-proxied by the frontend server.
- Removed .env, .git, logs and backups from the deployment ZIP.

Note: Free hosts with ephemeral disks may reset SQLite data after redeploy/restart.
