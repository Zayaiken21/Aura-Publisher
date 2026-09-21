# Aura Publisher Pro — Connected Render Build

Frontend: https://zayaiken21.github.io/Aura-Publisher/
Backend: https://aura-publisher.onrender.com

The Render URL is hard-wired in `config.js`; users no longer enter it.

## Render
Build command: `npm install`
Start command: `npm start`
Health path: `/healthz`

Environment variables:
- `ADMIN_TOKEN` = create one long private random value.
- `ALLOWED_ORIGINS` = `https://zayaiken21.github.io` (also built into this server as the default allowed GitHub Pages origin).

After changing environment variables, redeploy Render.

## Aura Connections screen
### Private Access Token
Enter the exact same value as Render's `ADMIN_TOKEN`. Aura stores it in localStorage on that browser so you do not have to re-enter it each visit. This is not the Render URL, WordPress password, or ChatGPT password.

### WordPress
- Site URL: root WordPress URL, e.g. `https://example.com`
- Username: WordPress publishing user's username
- Application Password: WordPress Users > Profile > Application Passwords. Do not use the normal WordPress password.

## GitHub Pages
Keep `index.html`, `styles.css`, `app.js`, and `config.js` at the repository root. `index.html` is the Pages entry point.

## Failed to fetch
This build fixes the most likely browser-side cause by allowing `https://zayaiken21.github.io` in CORS and explicitly allowing `x-aura-token`. If it still appears, confirm Render is deployed from these new files and then open `/healthz` directly. A successful health response should be JSON.
