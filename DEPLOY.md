# Deploying

Railway builds this repo from `Dockerfile` — it compiles the React frontend and
serves it from FastAPI as a single service. There are two ways to ship.

## 1. Push to the deploy branch (normal path)

Railway watches a branch (whichever one the service is connected to in the
dashboard, normally `main`) and rebuilds when it moves. Merging a PR is what
deploys it. Nothing else is required.

## 2. `railway up` from your machine (manual path)

For deploying without going through git — a hotfix, or testing a branch on the
real infrastructure.

### One-time setup

```bash
# Sign in — opens a browser, or gives a device code over SSH
npx @railway/cli login

# Point this directory at the Railway project (stored per machine, not in git)
npx @railway/cli link
```

For CI or any machine without a browser, use a project token instead of
`login` — Railway dashboard → your project → **Settings → Tokens**:

```bash
export RAILWAY_TOKEN=<project token>          # macOS / Linux
$env:RAILWAY_TOKEN = "<project token>"        # Windows
```

Never commit the token. It is an environment variable, not a file.

### Deploying

```bash
./deploy.sh          # macOS / Linux
.\deploy.ps1         # Windows
```

Both scripts check you're signed in, compile the frontend, and then run
`railway up`. Extra arguments pass through, so `./deploy.sh --detach` starts the
deploy and returns instead of streaming build logs.

**Why the local build step:** the Dockerfile runs `npm run build`, which is
`tsc -b && vite build`. A type error fails the deploy *inside the image*, minutes
after the upload. Compiling first surfaces it in seconds. Skip it with
`SKIP_BUILD_CHECK=1` if you're deploying a backend-only change.

## Environment variables on Railway

Set these on the service (dashboard → **Variables**). They are read by
`backend/app/core/config.py`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | — | All AI features fail without it |
| `SECRET_KEY` | **yes** in production | `dev-secret-key-change-in-production` | Session signing |
| `GEMINI_MODEL` | no | `gemini-3.6-flash` | Swap models without a code change |
| `GEMINI_THINKING_LEVEL` | no | `HIGH` | `MINIMAL`, `LOW`, `MEDIUM`, or `HIGH` |
| `DEBUG` | no | `false` | Verbose logging |

## Notes

- **`google-genai` must be 2.x.** Gemini 3 models take
  `ThinkingConfig(thinking_level=...)` and reject the older numeric
  `thinking_budget`; the 1.x SDK has no `thinking_level` field at all. If a
  deploy reuses a cached image layer with the old SDK, every AI call fails —
  force a clean rebuild after changing `backend/requirements.txt`.
- **The desktop app does not need rebuilding for web changes.** `desktop/app.py`
  is a PyWebView window pointing at the Railway URL and bundles no frontend
  assets, so a deploy updates it automatically. Only rebuild
  (`build_desktop.ps1`, Windows only) when `desktop/app.py` itself changes.
- **The Android APK does need rebuilding**, because it bundles the frontend.
  Run `npm run build` then `npx cap sync android` in `frontend/`, then rebuild
  the APK.
- `.railwayignore` controls what `railway up` uploads. It already excludes
  `node_modules`, `frontend/dist`, `android`, and `backend/data`.
