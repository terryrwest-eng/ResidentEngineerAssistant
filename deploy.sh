#!/usr/bin/env bash
#
# deploy.sh — Deploy this repo to Railway (macOS / Linux / CI).
# Windows equivalent: deploy.ps1
#
# Railway builds from the Dockerfile, which runs `npm run build` inside the
# image. A frontend type error therefore fails the deploy *after* the upload,
# several minutes in. This script compiles the frontend first so that failure
# shows up in seconds, locally, before anything is sent.
#
# Usage:
#   ./deploy.sh                  # build check, then deploy and stream logs
#   ./deploy.sh --detach         # deploy and return immediately
#   SKIP_BUILD_CHECK=1 ./deploy.sh
#
# Any extra arguments are passed straight through to `railway up`.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

RAILWAY=(npx --yes @railway/cli@5)

echo "=== Deploying RE Report Assistant to Railway ==="

# --- Step 1: Authentication -------------------------------------------------
# RAILWAY_TOKEN is the scripted path. Interactive `railway login` needs a
# browser (or a device code over SSH), so it can't be done unattended.
echo
echo "[1/3] Checking Railway authentication..."
if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
  echo "      Using RAILWAY_TOKEN from the environment."
elif "${RAILWAY[@]}" whoami >/dev/null 2>&1; then
  echo "      Using existing login: $("${RAILWAY[@]}" whoami 2>/dev/null | head -1)"
else
  cat >&2 <<'EOF'

  Not signed in to Railway. Do one of these first:

    Interactive (opens a browser):
      npx @railway/cli login

    Unattended (CI, or no browser available):
      export RAILWAY_TOKEN=<project token>
      Railway dashboard -> your project -> Settings -> Tokens

  Then link this directory to the project, once per machine:
      npx @railway/cli link

EOF
  exit 1
fi

# --- Step 2: Build check ----------------------------------------------------
# Same command the Dockerfile runs: `tsc -b && vite build`.
echo
echo "[2/3] Compiling the frontend (same command the Dockerfile runs)..."
if [[ "${SKIP_BUILD_CHECK:-}" == "1" ]]; then
  echo "      Skipped (SKIP_BUILD_CHECK=1)."
elif [[ ! -d frontend/node_modules ]]; then
  echo "      Skipped — frontend/node_modules is missing. Run 'npm ci' in"
  echo "      frontend/ to catch build errors before deploying."
else
  if ! ( cd frontend && npm run build ); then
    echo >&2
    echo "  Frontend build failed. Railway would fail the same way after" >&2
    echo "  uploading, so the deploy is stopped here. Fix the error above." >&2
    exit 1
  fi
  echo "      Build OK."
fi

# --- Step 3: Deploy ---------------------------------------------------------
echo
echo "[3/3] Uploading and deploying..."
exec "${RAILWAY[@]}" up "$@"
