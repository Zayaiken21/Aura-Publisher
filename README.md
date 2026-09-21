# Aura Publisher Pro V7 — ZIP Publishing Pipeline

V7 fixes malformed imports and adds end-to-end ZIP asset publishing.

## GitHub Pages
Put every file in this ZIP directly in the repository root. `index.html` must remain at root.

## Render
Build: `npm install`
Start: `npm start`
Health: `/healthz`
Environment: `ALLOWED_ORIGINS=https://zayaiken21.github.io`

## Preferred import ZIP
Create one ZIP containing `aura-posts.json` (preferred) or a CSV plus the exact image filenames referenced by each post. Images may be JPG/JPEG/PNG/WEBP.

Example:
- aura-posts.json
- MA-0201-featured.jpg
- MA-0201-01.jpg
- MA-0201-02.jpg
- MA-0202-featured.jpg
- MA-0202-01.jpg

V7 extracts the ZIP on Render, validates every post, returns the images to the browser, and stores image blobs in IndexedDB on the user's device. Publishing loads the exact required images from IndexedDB and uploads them to WordPress Media before creating the post.

Malformed rows are no longer silently converted to `Untitled` posts with random UUIDs. Missing post_id/title/sections or referenced images produce `IMPORT INVALID`, and Publish is disabled.

## JSON schema
Each post should use `post_id`, `title`, `slug`, `excerpt`, `categories`, `tags`, `status`, `featured_image`, and `sections`. Image objects use `filename`, `alt_text`, `prompt`, `caption`, `purpose`. Section types: `intro`, `heading`, `paragraph`, `image`, `ad`, `checklist`, `html`.

## WordPress
Use the WordPress login username and a generated Application Password. V7 strips display spaces from the generated Application Password before Basic Auth. The password is not stored in localStorage.
