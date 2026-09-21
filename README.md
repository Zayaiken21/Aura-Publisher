# Aura Publisher Pro 2.0

A split frontend/backend WordPress publishing command center. The GitHub Pages frontend stores the workspace on-device; the Node backend parses imports and talks to WordPress. ChatGPT Pro Mode uses structured JSON produced in ChatGPT and does **not** require an OpenAI API key. Optional unattended generation can use a separately billed OpenAI API key.

## Features
- Blue aura / lightning / gold-cross responsive UI
- Local JSON workspace export/import (secrets excluded)
- Import JSON, CSV, PDF, DOCX, Markdown, TXT, HTML, ZIP and images
- Deterministic `post_id`, image slots, featured image and ad slots
- Validation before publish
- WordPress categories/tags auto-create
- WordPress media upload + alt text
- Draft, pending, private, future/scheduled and publish statuses
- WordPress Application Password authentication
- MCP server starter tools
- Optional OpenAI API automation endpoint
- Helmet, CORS allowlist, rate limiting and backend access token

## 1. Hosting architecture
**GitHub Pages:** `index.html`, `styles.css`, `app.js`, `config.js` only.

**Hostinger Node app:** `server.js`, `package.json`, `.env` and dependencies. Do not put `.env` or secrets in the Pages repository.

**WordPress:** your existing Hostinger WordPress site.

## 2. Host backend on Hostinger
Use Hostinger Business Web Hosting / supported Cloud plan Node Web App, or a VPS. In hPanel: Websites → Add Website → Deploy Web App. Deploy this project from GitHub or ZIP. Start command: `npm start`. Node 20+ recommended.

Create environment variables from `.env.example`. Set `ALLOWED_ORIGINS` to the exact GitHub Pages/custom frontend origins. Set a long random `ADMIN_TOKEN`. Add `OPENAI_API_KEY` only if you want separately billed unattended API generation.

Point a subdomain such as `api.example.com` to the Node app and keep HTTPS enabled.

## 3. Host frontend on GitHub Pages
Create a repository containing only `index.html`, `styles.css`, `app.js`, `config.js`. In `config.js`, set `API_BASE` to the HTTPS backend, e.g. `https://api.example.com`. Repository Settings → Pages → deploy from the branch/root. A custom domain is optional.

## 4. WordPress connection
In WordPress: Users → Profile/Edit User → Application Passwords → create `Aura Publisher`. In Aura Connections, enter the HTTPS site URL, WordPress username and generated Application Password. Click Test WordPress. Use a dedicated WordPress user with only the permissions Aura needs.

## 5. ChatGPT Pro Mode
ChatGPT Pro is not an external API credential. Use ChatGPT to produce Aura JSON packages, then import them. This keeps Pro as your writing workspace while Aura performs deterministic formatting and WordPress publishing. For unattended generation, configure the optional OpenAI API separately.

## 6. Canonical Aura JSON
```json
{
  "post_id":"MA-0103",
  "title":"How to Plan Composting Step by Step",
  "slug":"how-to-plan-composting-step-by-step",
  "category":["Gardening"],
  "tags":["composting","small spaces"],
  "excerpt":"A practical guide...",
  "status":"draft",
  "featured_image":{"file":"MA-0103-featured.jpg","alt":"Small-space compost setup"},
  "sections":[
    {"type":"intro","content":"Opening..."},
    {"type":"heading","level":2,"text":"Choose Your Setup"},
    {"type":"paragraph","content":"..."},
    {"type":"image","file":"MA-0103-01.jpg","alt":"Countertop compost container"},
    {"type":"ad","slot":"article_ad_1"},
    {"type":"checklist","items":["Choose a bin","Save browns","Add greens"]}
  ]
}
```

## 7. Bulk CSV
Headers supported: `post_id,title,slug,category,tags,excerpt,status,content,focus`. Separate multiple tags with `|`. For complex formatting and asset placement, JSON is preferred.

## 8. Asset naming
Use deterministic names: `MA-0103-featured.jpg`, `MA-0103-01.jpg`, `MA-0103-02.jpg`. JSON image sections must reference the exact filename. Missing images remain explicit placeholders rather than silently moving another image into the wrong article.

## 9. Ad placements
Aura renders ad markers as `<div class="aura-ad-slot" data-slot="article_ad_1"></div>`. Let WordPress/theme/plugin decide how that slot becomes a real ad. This lets you change ad providers without rewriting every article.

## 10. Safe rollout
1. Test API.
2. Test WordPress.
3. Import one post.
4. Keep status `draft`.
5. Preview in WordPress.
6. Test featured/inline images and ad replacement.
7. Test 5-post batch.
8. Only then use `future` or `publish` in larger batches.

## Production notes
The browser workspace is convenience storage, not enterprise identity/authentication. For a public multi-tenant SaaS, add server-side accounts, a database, encrypted per-user secrets, password reset/email verification, audit logs and object storage. The current design is strongest as a private/team self-hosted publisher with a protected backend.
