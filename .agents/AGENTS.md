# Workspace Rules — Daily Reporter V3

## Git
- Git is in use. Commit and push work to the designated feature branch.

## Deployment
- Deploy with the **Railway CLI** (`railway up`) — it uploads from the local
  filesystem, so make sure the local folder holds the code you intend to ship
  (pull/merge the branch first).
- One Railway deploy updates **three** surfaces, because the Dockerfile builds
  the React app and FastAPI serves it from `/app/static`:
  - the backend API
  - the web app
  - the desktop app (a PyWebView shell that loads the Railway URL live)
- The **Android APK** is the exception — it bundles its own copy of the web
  assets, so it needs `npm run build && npx cap sync android`, then a build in
  Android Studio. Deploy the backend before installing a new APK.
- The **Chrome extension** is loaded unpacked and updated separately.

## Testing
- `python3 backend/tests/*.py` — offline verification scripts (Gemini and
  Open-Meteo are mocked, so they cost nothing). See `backend/tests/README.md`.
- `cd frontend && npm run build` must finish with zero TypeScript errors.
