# Aura Publisher Pro v15 — WordPress Site Studio

## The raw-CSS/category-template fix
V14 tried to place a `<style>` block inside the WordPress category description. Many WordPress themes/security filters strip the `<style>` tag while leaving its CSS text behind, which is why the Gardening archive could visibly print `.aura-site-template{...}` instead of adopting the design. V15 no longer publishes category CSS into category content.

## Aura Site Bridge (included)
The root of this package contains `aura-wordpress-bridge.zip`. Install it once in WordPress under **Plugins → Add New → Upload Plugin → Activate**. Then open Aura → Template Studio → **Refresh WordPress**. The status should read **Active**.

The bridge adds:
- Full category archive takeovers while preserving the WordPress header/footer.
- A safer “Aura header + theme posts” mode.
- Dedicated responsive CSS loaded as a real WordPress stylesheet, never pasted into category text.
- Automatic cleanup of the old raw CSS category description when a V15 category template is published.
- Sticky side affiliate cards on desktop/tablet that become inline cards on mobile.
- `rel="sponsored nofollow noopener"` on affiliate links.
- Live WordPress/PHP/theme diagnostics through the authenticated REST API.
- Responsive styling for Aura resource posts and resource hubs.

## Template Studio improvements
- Desktop 1440, tablet 820 and mobile 390 previews.
- Full archive vs header-only category modes.
- Toggle to include the live category post grid below the custom editorial sections.
- Affiliate conversion layer with label, title, description, image, URL, CTA and disclosure fields.
- Section items can now be made clickable with `Title | https://destination.com`.
- CTA and feature sections have their own destination URL.
- WordPress category presets still map to the Mindful Adaption slugs.
- Resources preset can update a matching Resources page and uses the WordPress Bridge stylesheet.

## Branding
The supplied Mindful Adaption artwork is included as `mindful-adaption-logo.jpg` and is used in the Aura app header/lock screen with an added cross badge. `aura-icon.svg` remains the lightweight installable web-app icon (journal + cross + blue lightning).

## Mobile/device work
- Template Studio collapses to one column on narrower screens.
- Bridge controls and affiliate controls become full-width touch targets.
- Preview supports desktop/tablet/mobile widths.
- Sticky affiliate rails automatically become normal inline content on smaller screens.
- Inputs remain 16px on iPhone to avoid focus zoom/layout drift.

## Deploy
### Front end / GitHub Pages
Upload the root files to the repository root. `index.html`, `config.js`, `aura-wordpress-bridge.zip`, `mindful-adaption-logo.jpg` and `manifest.webmanifest` should remain alongside the JS/CSS files.

### Aura engine / Render
- Build: `npm install`
- Start: `npm start`
- Health: `/healthz`
- Set `ALLOWED_ORIGINS` to the URL that hosts the front end.

## Recommended WordPress workflow
1. Install and activate `aura-wordpress-bridge.zip`.
2. In Aura, connect WordPress using an Application Password.
3. Open Template Studio and refresh WordPress. Confirm **Aura Site Bridge: Active**.
4. Load a category preset, select the correct WordPress category, choose Full Aura Archive, preview desktop/tablet/mobile, then publish.
5. For the Resources hub, load the Resources preset, choose the existing Resources page, add your real resource URLs and affiliate cards, then publish.
6. Keep affiliate disclosures accurate and only link products/services that genuinely fit the page.
