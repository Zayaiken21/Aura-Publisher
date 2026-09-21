# Aura Publisher Pro V9

V9 fixes stale V7/V8 frontend caching, removes all legacy queues during upgrade, uses a new IndexedDB asset store keyed by canonical lowercase filename, verifies every image after storage before accepting posts, adds an X remove button per post and Clear Queue, and keeps ZIP/JSON/CSV + WordPress publishing.

## Deploy
Upload every file to the GitHub repo root. Render: `npm install`, `npm start`, health `/healthz`, `ALLOWED_ORIGINS=https://zayaiken21.github.io`. Clear build cache and deploy.

The frontend intentionally loads `aura-v9.js`, a new filename, so Safari/GitHub Pages cannot keep executing an old cached V7/V8 app script. Test Engine should report API version 3.2.0.
