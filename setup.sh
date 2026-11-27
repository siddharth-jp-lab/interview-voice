#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22 or newer, then run ./setup.sh again."
  exit 1
fi

major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$major" -lt 22 ]]; then
  echo "Node.js 22 or newer is required. This machine has $(node -v)."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is missing. Reinstall Node.js 22 or newer, then run ./setup.sh again."
  exit 1
fi

npm ci

if [[ ! -f .env ]]; then
  cp .env.example .env
  secret="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs';
    const secret = process.argv[1];
    const text = readFileSync('.env', 'utf8').replace(/^SESSION_SECRET=.*$/m, 'SESSION_SECRET=' + secret);
    writeFileSync('.env', text);
  " "$secret"
  echo "Created .env and a SESSION_SECRET. Fill in OPENAI_API_KEY, ALLOWED_EMAIL, and APP_PASSPHRASE."
else
  echo ".env already exists, so it was left unchanged."
fi

echo "Start the API with: npm run server"
echo "Start the page with: npm run dev"
echo "Then open http://localhost:5173"
