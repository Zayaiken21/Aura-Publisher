# Aura Publisher Pro V5

Configured frontend: https://zayaiken21.github.io/Aura-Publisher/
Configured backend: https://aura-publisher.onrender.com

## Render
Build: `npm install`
Start: `npm start`
Health check: `/healthz`
Environment: `ALLOWED_ORIGINS=https://zayaiken21.github.io`

V5 removes the browser Aura access-token field. Do not hard-code secrets into GitHub Pages. If you previously exposed an ADMIN_TOKEN, rotate it. It is not needed for browser routes in this build.

## WordPress
Enter the root Site URL, WordPress username (email may work depending on the site), and a WordPress Application Password. Aura discovers `/wp-json/` and the `?rest_route=/` fallback, then validates the current credentials with `wp/v2/users/me`. Changing any credential immediately invalidates the previous success state.

## Deploy
Put all files at the GitHub repository root so `index.html` is at `/index.html`. Render can use the same repository and runs `server.js`.
