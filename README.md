# Aura Publisher Pro V17 — Originality + Routing Studio

V17 upgrades Aura into a more complete WordPress publishing and site-formatting workspace while preserving the existing queue/import workflow.

## Highlights

- **Originality Engine V7**: every article gets an independent editorial fingerprint. Aura no longer repairs imports by forcing one universal article skeleton.
- **Internal Link Router**: search real WordPress posts, pages and categories, then use Smart, Rotate, Random or Manual routing. Imported stories may also carry their own verified `internal_links`.
- **Template auto-routing**: unfinished template cards and CTAs can resolve to real WordPress destinations.
- **Dynamic WordPress Query blocks**: category/page templates can show current published posts based on a search phrase and/or WordPress category.
- **Technical SEO controls**: SEO title, description, canonical, robots, Open Graph, Twitter cards, schema and optional breadcrumbs through Aura Site Bridge.
- **Responsive shell**: mobile uses one contained Workspace selector instead of overflowing tab bubbles. Desktop retains the full navigation.
- **Large preview**: opens inside Aura as a full-screen dialog with a Back control; it no longer destroys the Studio state.
- **Version-visible engine status**: the header always identifies the current V17.0 build.
- **Explicit Log out control**: no ambiguous back-arrow logout button.

## WordPress bridge

Install the included `aura-wordpress-bridge.zip` (**Aura Site Bridge V1.3.0**) on the self-hosted WordPress site.

1. WordPress → Plugins.
2. Deactivate/delete an older Aura Site Bridge version.
3. Add Plugin → Upload Plugin.
4. Upload `aura-wordpress-bridge.zip` and activate it.
5. In Aura, open Template Studio and press **Refresh WordPress**.

V1.3.0 adds dynamic query rendering, richer SEO metadata/schema output, category archive rendering and link-routing capabilities.

## Deployment

Deploy the contents of this folder as the Aura application and redeploy `server.js` on the backend host. The package version is `17.0.0`.

User workspace data remains in Aura's existing IndexedDB/device storage. Replacing the application files does not intentionally clear the workspace database.

## SEO note

Aura's SEO score is a technical/completeness audit. It does not guarantee a search-engine position. Ranking also depends on content usefulness, intent match, crawl/index status, competition, authority, links and other search-engine signals.
