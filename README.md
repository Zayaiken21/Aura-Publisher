# Aura Publisher Pro V12

WordPress auto-publisher fed by ONE ChatGPT ZIP per batch.

## Files
- **GitHub Pages (website):** `index.html`, `styles.css`, `aura-app.js`, `aura-vault.js`, `aura-prompt.js`, `config.js` (keep your existing one)
- **Render (engine):** `server.js`, `package.json` (`mcp-server.js` optional, unchanged)
- `.env.example` lists the Render settings

## Render settings
- `ALLOWED_ORIGINS=https://zayaiken21.github.io`
- `OPENAI_API_KEY=` needed for photo creation (or add your own key in the app under Connections)
- `OPENAI_IMAGE_MODEL=gpt-image-1` (the same image model ChatGPT uses)
- Test engine in the app should show **API 5.3.0**

## Workflow
1. **Standard & ads:** paste your affiliate list (`Name | link | keywords | button | description`), pick ad placement, cover style and photo speed.
2. **ChatGPT prompt:** paste your post list (`Title | keyword | notes | affiliate IDs`). Copy one batch at a time into ChatGPT.
3. ChatGPT returns **one ZIP**: every post, all SEO fields and a detailed brief for every photo.
4. **Import** the ZIP. Aura checks the Mindful Adaption Standard, completes the SEO (meta title and description, excerpt, focus keyphrase, tags, alt text, media titles and descriptions), places links and ads, and creates every photo automatically — the featured cover with the post title on it, styled for the post's category.
5. **Preview** (exact WordPress output plus a Google preview and SEO score), then publish or schedule.

## Staying under limits
- Photos are created one at a time at your chosen speed (default 4 per minute); Aura waits and retries if OpenAI asks it to slow down, and pauses with a message if your OpenAI quota runs out.
- Bulk publishing is spaced 2 seconds apart; WordPress busy responses are retried automatically.
- ChatGPT batches default to 2 posts so each reply finishes in one message.

## Notes
- Real photos inside a ZIP are used as they are, even with generic names like `image_1.png` (matched in order). Drawn or coded placeholder images are discarded automatically.
- Side ads float beside the text and FAQ rich results are added when the WordPress user is an Administrator. For other roles, paste the side-card CSS (Standard & ads) into Appearance → Customize → Additional CSS.
- Meta title, description and focus keyphrase are sent to Yoast / Rank Math. If the site does not accept them from outside, the post still publishes and the excerpt is always saved.
