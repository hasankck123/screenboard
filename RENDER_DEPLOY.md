# Render deploy

This app is a single Node.js web service. Render provides public HTTPS, so the
local development certificate is not used in production.

## Files Render needs

- `package.json`
- `server.js`
- `public/`
- `render.yaml`

Do not upload `certs/` or `tools/`.

## Render settings

Create a new Web Service from a GitHub repo that contains this folder.

Use these settings:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /healthz
```

Environment variables:

```text
NODE_ENV=production
PRESENTER_PASSWORD=choose-a-strong-password
MAX_PRESENTERS=2
```

Render automatically sets `PORT`, and `server.js` listens on it.

## Important behavior

Rooms, board strokes, and presenter sessions are currently stored in memory.
They reset when the Render service restarts or sleeps/wakes on a free plan.

For a real class system, the next production step is adding persistent storage
for rooms and board history.
