# Aura Publisher Pro V18.0

V18 upgrades Template Studio for the real Mindful Adaption WordPress/Kadence workflow.

## Highlights

- Real WordPress category/page/post routing with up to 1,000 posts loaded for Studio discovery.
- Dynamic WordPress Query sections use real published post titles, excerpts, featured images and links.
- Mindful Adaption category presets now contain live query blocks instead of fake/static article grids.
- Kadence + Ad Revenue Layout controls: reading width, 300/336px rail, sticky rail setting, archive columns, image ratio, ad frequency and CLS-safe reserved heights.
- Reserved Ad Slot section type for intentional monetization positions.
- Archive loop can inject a native ad card after every N real WordPress posts through the `aura_archive_ad_slot` WordPress action.
- Featured images in category/archive cards link to the real post.
- Affiliate cards support Sticky Rail, Inline, or Rail + Inline placement and can be assigned after a specific template section.
- Aura Site Bridge V1.4.0 adds revenue-layout metadata, CLS ad reservations, linked archive images and inline affiliate modules.
- V18 editorial prompt keeps the Originality Engine while adding monetization-safe formatting and verified routing rules.
- `KADENCE-REVENUE-BLUEPRINT.md` contains the complete Kadence implementation checklist.

## WordPress install / upgrade

1. Deploy the V18 frontend files and redeploy `server.js`.
2. In WordPress, deactivate/delete the old Aura Site Bridge.
3. Upload `aura-wordpress-bridge.zip` from this package.
4. Activate Aura Site Bridge V1.4.0.
5. Open Aura → Template Studio → Refresh WordPress.
6. Choose the real category/page and load the matching preset.
7. Preview desktop/tablet/mobile, then publish.

## Kadence

Read `KADENCE-REVENUE-BLUEPRINT.md` before changing the global Kadence Theme layout. Aura does not silently overwrite Kadence Customizer options; it publishes compatible template structure through the Bridge and gives you explicit controls for the monetization layer.
