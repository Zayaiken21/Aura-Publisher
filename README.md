# Aura Publisher Pro V11

**Frontend (GitHub Pages):** index.html, styles.css, config.js, aura-vault.js, aura-prompt.js, aura-app.js
**Backend (Render):** server.js (API 5.0.0) — `npm install`, `npm start`, health `/healthz`

## What's new in V11
- **Accounts with passwords.** Each user creates an Aura account; the WordPress login and settings are AES-256-GCM encrypted on the device with a key derived from the password (PBKDF2-SHA256, 310k iterations). Auto-lock, lockout after repeated wrong attempts, encrypted backup/restore.
- **Password reset** uses the WordPress Application Password saved in the account as the recovery key. Without it, the account must be deleted and recreated.
- **Real publishing.** Publish now, schedule (with day spacing), pending review, draft or private. Re-publishing updates the same WordPress post instead of duplicating it and reuses uploaded images.
- **Mindful Adaption Standard** enforced on import: featured image → intro → H2 sections → image → ad → examples → image → ad → checklist → takeaway. Missing pieces are filled and listed as auto-fixes.
- **Ads in every post** from the Ad Library (link cards or HTML ad code), rotated per post.
- **Alt text** for every image from a template when missing.
- **AI image generation** for any image missing from the ZIP (OpenAI Images API), with retry/backoff on rate limits.
- **ChatGPT prompt builder** tab with your ad links built in.
- Fixes: `?rest_route=` query URLs, term lookup with HTML entities / `term_exists`, correct rate limiting behind Render's proxy, pdf-parse ESM crash, non-ASCII upload filenames, WordPress 429/503 retries.

## Render environment
```
ALLOWED_ORIGINS=https://zayaiken21.github.io
OPENAI_API_KEY=sk-...            # enables image generation for every user
OPENAI_IMAGE_MODEL=gpt-image-1   # optional
```
`aura-v10.js` and `app.js` are no longer loaded and can be deleted.
