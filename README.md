# Aura Publisher Pro v14

## New in v14 — Site Studio
- Separate WordPress Template Studio; the existing post queue is unchanged.
- Category archive content, WordPress page, special post and resource-post destinations.
- Seven Mindful Adaption category/page presets plus custom blocks and saved variations.
- WordPress site structure browser for categories, pages and recent posts.
- Resource Lab with 10 ready-to-go free-resource starters.
- Direct PDF/DOCX/ZIP/etc. resource upload that creates a WordPress resource post with a download button.
- Responsive desktop/mobile live preview.
- New blue lightning-cross + journal SVG app icon and in-app mark.
- Builder projects are stored in IndexedDB alongside the workspace, not localStorage.

## Important WordPress note
WordPress exposes category descriptions through the core REST API, so Aura can publish rich category landing content there. Whether that content replaces the *entire* archive template depends on the active WordPress theme. Page/post/resource destinations are fully controlled by Aura.

# Aura Publisher Pro V13

V13 is the large-batch publishing build.

## What changed
- Queue metadata moved from `localStorage` to IndexedDB, removing the small localStorage quota that caused **“Browser storage is full”** on large article runs.
- Existing V11/V12 local queues migrate automatically the first time the user signs in.
- Images remain in IndexedDB only until WordPress confirms its media IDs. Aura then releases the local image blobs automatically while keeping the WordPress media map, so published batches do not continuously consume browser storage.
- Published WordPress media counts as available during later validation, so automatic cleanup does not make a published post look broken.
- `Clear all` removes queue metadata and local photo cache without touching WordPress.
- The prompt planner supports up to 1,000 planned posts and up to 10 posts per AI batch. Large runs are automatically split into numbered batches.
- Prompt V6 has a strict anti-template differentiation gate, mandatory `article-1` and `article-2` ad slots, affiliate safety rules, unique photo direction, and an SEO contract.
- Aura's standardizer still repairs missing ad/image/checklist/takeaway slots and audits SEO on import. “SEO 100” is treated as completion of Aura's technical/content checklist, not a guarantee of search-engine rankings.

## Deploy
GitHub Pages: upload all files in this ZIP to the repository root. `index.html` must stay at root.

Render:
- Build: `npm install`
- Start: `npm start`
- Health: `/healthz`
- `ALLOWED_ORIGINS=https://zayaiken21.github.io`

After deploy, **Test Engine** should show API `6.0.0`.

## Recommended workflow
1. Open **Prompt**, paste any number of story ideas, and choose an AI batch size (3 is a strong default; up to 10 is supported).
2. Copy the generated batch prompt into ChatGPT.
3. Import each returned ZIP into Aura.
4. Aura normalizes structure, audits/repairs SEO metadata, guarantees ad slots, matches/generates photos, and validates each post.
5. Preview and publish/schedule.
6. After WordPress confirms media, Aura automatically frees those local image blobs.

The standalone `AURA-MASTER-PROMPT-V6.md` is also included for use outside the app.
