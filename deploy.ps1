# deploy.ps1 — Deploy this repo to Railway (Windows)
#
# macOS / Linux / CI equivalent: deploy.sh
#
# Railway builds from the Dockerfile, which runs `npm run build` inside the
# image. A frontend type error therefore fails the deploy *after* the upload,
# several minutes in. This script compiles the frontend first so that failure
# shows up in seconds, locally, before anything is sent.
#
# Usage:
#   .\deploy.ps1                 # build check, then deploy and stream logs
#   .\deploy.ps1 --detach        # deploy and return immediately
#   $env:SKIP_BUILD_CHECK = "1"; .\deploy.ps1
#
# Any extra arguments are passed straight through to `railway up`.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RailwayArgs
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=== Deploying RE Report Assistant to Railway ===" -ForegroundColor Cyan

# --- Step 1: Authentication ---
# RAILWAY_TOKEN is the scripted path. Interactive `railway login` needs a
# browser, so it can't be done unattended.
Write-Host "`n[1/3] Checking Railway authentication..." -ForegroundColor Yellow

$authed = $false
if ($env:RAILWAY_TOKEN) {
    Write-Host "      Using RAILWAY_TOKEN from the environment."
    $authed = $true
} else {
    npx --yes '@railway/cli@5' whoami *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "      Using existing railway login."
        $authed = $true
    }
}

if (-not $authed) {
    Write-Host @"

  Not signed in to Railway. Do one of these first:

    Interactive (opens a browser):
      npx @railway/cli login

    Unattended (CI, or no browser available):
      `$env:RAILWAY_TOKEN = "<project token>"
      Railway dashboard -> your project -> Settings -> Tokens

  Then link this directory to the project, once per machine:
      npx @railway/cli link

"@ -ForegroundColor Red
    exit 1
}

# --- Step 2: Build check ---
# Same command the Dockerfile runs: `tsc -b && vite build`.
Write-Host "`n[2/3] Compiling the frontend (same command the Dockerfile runs)..." -ForegroundColor Yellow

if ($env:SKIP_BUILD_CHECK -eq "1") {
    Write-Host "      Skipped (SKIP_BUILD_CHECK=1)."
} elseif (-not (Test-Path "frontend/node_modules")) {
    Write-Host "      Skipped - frontend/node_modules is missing. Run 'npm ci' in"
    Write-Host "      frontend/ to catch build errors before deploying."
} else {
    Push-Location frontend
    npm run build
    $buildFailed = ($LASTEXITCODE -ne 0)
    Pop-Location

    if ($buildFailed) {
        Write-Host "`n  Frontend build failed. Railway would fail the same way after" -ForegroundColor Red
        Write-Host "  uploading, so the deploy is stopped here. Fix the error above." -ForegroundColor Red
        exit 1
    }
    Write-Host "      Build OK." -ForegroundColor Green
}

# --- Step 3: Deploy ---
Write-Host "`n[3/3] Uploading and deploying..." -ForegroundColor Yellow
npx --yes '@railway/cli@5' up @RailwayArgs
exit $LASTEXITCODE
