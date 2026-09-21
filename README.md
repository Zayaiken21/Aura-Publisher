# Aura Publisher Pro V10

V10 fixes structured ZIP imports. If a package contains both `aura-posts.json` and `aura-posts.csv`, Aura imports the JSON manifest only (they are alternate copies, not 2 batches). Asset-manifest/validation JSON files are ignored as post manifests. CSV-only packages parse `sections_json` into real sections. The queue has an × button per post and Clear All for the entire queue/assets.

Deploy all files together. Render: `npm install`, `npm start`, health `/healthz`, `ALLOWED_ORIGINS=https://zayaiken21.github.io`. Test Engine should report API version 4.0.0.
