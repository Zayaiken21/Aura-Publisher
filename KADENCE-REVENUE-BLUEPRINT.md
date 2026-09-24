# Aura V18 — Kadence Revenue + Core Web Vitals Blueprint

This blueprint is for sites using Kadence Theme + Kadence Blocks Pro / Theme Kit Pro and display advertising (Mediavine, Raptive, AdSense, or an ad-management layer). It is designed to preserve layout stability while leaving monetization locations predictable.

## 1. Single Post Layout

### Customizer
Go to **Appearance → Customize → Posts/Pages Layout → Single Post Layout**.

Recommended baseline:
- Default Post Layout: **Right Sidebar**
- Main reading column target: **720–780px**
- Overall content container: **1120–1180px**
- Sidebar target: **336px** (300px is acceptable if your ad stack requires it)
- Content Style: **Unboxed** for long editorial posts; use Boxed only if the brand system needs it
- Vertical spacing: **Medium / generous**
- Featured image: **Above or Behind** depending on template; keep an explicit image aspect ratio
- Related posts: **3 columns desktop, 1 mobile**

### Sidebar
Use a 336px ad-safe sidebar. Keep the final ad/recommendation module sticky only after the reader reaches it; do not make the entire sidebar fixed from the top.

Suggested CSS class on the final sidebar unit: `.aura-sticky-ad`.

### Kadence Elements placements
Create Content Section Elements under **Appearance → Kadence → Elements**.
Recommended placements:
- Leaderboard / top monetization: **Before Entry Content** or a title-adjacent placement where it does not interrupt the H1.
- First contextual unit: **After First/Second/Third/Fourth Paragraph** depending on article architecture.
- End-of-post recommendation or card: **After Entry Content**.
- Custom scripts: use an **HTML Editor Element** in head/footer only when the ad provider explicitly requires it.

Do not place an ad between the H1 and essential article metadata if it makes the opening feel disconnected.

### Typography / readable density
For long-form editorial copy:
- Desktop body: **18–19px**
- Mobile body: **17–18px**
- Line-height: **1.68–1.78**
- Paragraph bottom margin: **1.15–1.4em**
- H2 top margin: **1.7–2.1em**
- H2 bottom margin: **0.55–0.8em**
- H3 top margin: **1.35–1.65em**

This creates comfortable reading depth without padding articles merely to create ad impressions.

## 2. Category / Archive Layout

Go to **Appearance → Customize → Posts/Pages Layout → Archive Layout**.

Recommended baseline:
- Archive Layout: **Normal or Fullwidth**
- Content Style: **Boxed** for card-based archives
- Desktop columns: **2** for editorial / ad-heavy pages; **3** only when cards remain large enough for useful excerpts
- Tablet: **2**
- Mobile: **1**
- Featured image ratio: **16:9** or **4:3**
- Image Size: **Large**
- **Image is Link to Post: ON**
- Show: category/eyebrow, title, short excerpt, read-more

### Native ad loop
Reserve an ad card after every **3rd** post by default. Aura Bridge exposes `.aura-native-ad-slot` and the `aura_archive_ad_slot` action so an ad manager or custom integration can render into the reserved area.

The reserved slot occupies space before the network creative loads, reducing CLS.

## 3. CLS / Core Web Vitals

Use fixed or minimum dimensions for every monetization slot. Aura uses responsive reservations rather than letting ad containers begin at zero height.

Suggested reservations:
- Top leaderboard: desktop **180–250px**, mobile **100–180px**
- In-content: desktop **280px**, mobile **250px**
- Sidebar: **600px**
- Native archive card: desktop **280px**, mobile **250px**

Use `content-visibility:auto` only on sections well below the fold and pair it with `contain-intrinsic-size` when appropriate.

## 4. Kadence Performance

Go to **Appearance → Customize → General → Performance**.

Recommended:
- **Load Google Fonts Locally: ON** when using Google Fonts
- **Preload local fonts:** only the one or two files needed above the fold
- **Enable CSS Preload: ON**, then test with your caching/CDN stack
- Kadence microdata/schema: enable only if another SEO/schema plugin is not already outputting overlapping schema
- Keep lightbox disabled if it is not used
- Avoid duplicate optimization features across Kadence, cache plugins and CDN (for example two different CSS combining/minification systems)

## 5. Aura Workflow

1. Refresh WordPress in Template Studio.
2. Select the real category/page destination.
3. Load the matching Mindful Adaption preset.
4. Keep **Real WordPress Feed** enabled so the page renders actual posts and featured images.
5. Set the category slug on Dynamic WordPress Query sections.
6. Choose archive columns and image ratio in **Kadence + Ad Revenue Layout**.
7. Set native ad frequency and reserved heights.
8. Import affiliate links; choose rail/inline placement intentionally.
9. Fill all unfinished internal links from the verified WordPress route pool.
10. Complete SEO title, description, canonical, social image and schema.
11. Preview desktop/tablet/mobile.
12. Publish through Aura Site Bridge.

The goal is a real editorial archive powered by WordPress data, not a static imitation of one.
