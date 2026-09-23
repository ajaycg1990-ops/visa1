#!/usr/bin/env bash
# NIEC Visa AI launcher for macOS and Linux.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 22.5 or newer from https://nodejs.org"
  exit 1
fi

exec node start.mjs
