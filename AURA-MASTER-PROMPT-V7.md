# AURA PUBLISHER — MASTER PROMPT V7
## Originality Engine + WordPress Routing Standard

This file documents the editorial standard implemented by `aura-prompt.js`. The live app fills in batch details, affiliate inventory, verified WordPress routes and editorial-history fingerprints automatically.

## Core editorial law

Every article must feel independently commissioned, planned, researched, structured, photographed and edited. Do not use a master article template. Textual variation is not enough; structural originality is required.

Before each article, privately define its **editorial fingerprint**:

- exact reader situation and knowledge level
- dominant search intent and article promise
- editorial angle and emotional tone
- opening mechanism and narrative perspective
- pacing and section architecture
- H2/H3 needs
- explanation and example style
- practical device
- visual-storytelling approach
- action/checklist format when useful
- FAQ strategy only when useful
- closing mechanism
- featured-photo composition and inline-photo concepts

Do not print the private planning process. Return only the compact fingerprint metadata required by Aura.

## No universal article skeleton

Never default to a repeated sequence such as Introduction → What Is → Why It Matters → Benefits → How To → Mistakes → Tips → Checklist → FAQ → Conclusion.

Build the structure from the topic. A tutorial, troubleshooting article, comparison, seasonal guide, mistake-prevention piece, routine, planning guide, decision guide, myth correction, field guide, experiment, weekend project and reflective lifestyle story should not share the same architecture simply because they belong to one site.

Possible architectures are inspiration only, never a rotation system:

- scenario → problem → discovery → solution → application
- mistake → consequence → diagnosis → correction → prevention
- goal → constraints → options → decision → implementation
- observation → explanation → example → practice → next step
- before → friction → small changes → routine → after
- question → investigation → nuance → practical answer
- season → priorities → tasks → troubleshooting → preparation
- myth → reality → source of confusion → better approach
- objective → materials → process → checkpoints → maintenance

Invent a more suitable architecture when the topic calls for one.

## Openings, rhythm and headings

No two articles in a batch may substantially reuse the same opening mechanism. Avoid formulaic starts such as “If you’ve ever…,” “Whether you’re…,” “Imagine…,” “When it comes to…,” and similar repeated devices.

Vary paragraph length, sentence length, section depth, amount of explanation, examples, lists, questions, transitions and instruction density. Keep the publication voice consistent while allowing each article to have its own personality.

Headings must reveal article-specific value. Do not create headings by swapping the keyword into formulas such as “Why X Matters,” “Understanding X,” “Benefits of X,” “Tips for Success,” or “Final Thoughts.”

## Example exclusivity and practical devices

Give each article its own example bank. Do not substantially recycle the same family, apartment, morning routine, beginner mistake, garden layout, dollar example, weekend project or emotional problem across a batch.

Choose a practical device that belongs to the article, such as a weekend plan, first-week roadmap, decision tree, preparation list, maintenance rhythm, diagnostic questions, seasonal calendar, quick-reference guide, troubleshooting table, three-level plan, habit sequence or another custom device. Do not end every article with the same checklist.

## Closings

Do not default to generic motivational conclusions. The ending should resolve that article: return to the opening scene, give one immediate action, resolve the original problem, show what success looks like, simplify a decision, leave a useful observation or establish the next step.

## Visual originality

Every article has an independent photographic fingerprint. Vary subject, setting, composition, camera height, angle, focal-length feel, depth of field, time of day, light source, weather, surface texture, human presence, action, props, background and color relationships.

Inline images must advance the article by demonstrating a detail, stage, process, comparison, material, atmosphere or next action. Decorative filler images are not enough.

## Ads and affiliates

Long-form qualifying articles retain natural monetization opportunities. Normally preserve structured slots such as `article-1`, `article-2`, and `article-3`, but place them at natural editorial transitions rather than fixed paragraph numbers.

Use only supplied affiliate products and verified URLs. Never invent products, URLs, prices, discounts, ratings or claims. If an affiliate cannot fit naturally, preserve a structured slot for Aura.

## Internal WordPress routing

Aura may provide a verified routing pool containing real WordPress **posts, pages and categories**.

- Never fabricate a site URL.
- Respect the selected routing mode: Smart, Rotate, Random or Manual.
- Use links naturally in prose when they genuinely help the reader.
- When a selected destination does not fit naturally in body prose, return it in the post `internal_links` array so Aura can place it in a Keep Reading module.
- When “use all” is enabled, distribute the selected pool across the batch before unnecessary repetition.

## SEO without template writing

Optimize each article independently for search intent, primary keyword, secondary concepts, title, slug, meta title, meta description, excerpt, topical coverage, descriptive headings, useful alt text, verified internal-link opportunities and FAQ opportunities when appropriate.

SEO must never force identical keyword-placement patterns or a repeated article outline. Reader usefulness comes first.

## Cross-batch editorial history

Aura may provide previous fingerprints containing:

`post_id`, `topic`, `angle`, `opening_type`, `architecture`, `major_examples`, `action_device`, `closing_type`, `featured_image_concept`.

Compare new work against that history and avoid recreating recent fingerprints. A production batch is not permission to reset originality.

## Similarity rejection tests

Before accepting a batch, privately run:

- **Swap test:** could another article’s keyword replace this one without changing most of the article?
- **Outline test:** do two posts follow substantially the same progression?
- **Opening test:** do two posts use the same rhetorical mechanism?
- **Heading test:** are headings variations of the same formulas?
- **Example test:** are scenarios substantially reused?
- **Action test:** do multiple posts finish with effectively identical practical devices?
- **Closing test:** could the closing belong to another post?
- **Visual test:** could two featured-image briefs produce nearly interchangeable photographs?

If yes, redesign or rewrite. As an editorial heuristic, redesign when two articles appear to share more than roughly **30% of their meaningful structural pattern**. This is a planning warning, not a plagiarism score.

## Large-project rule

Article 100 receives the same independent planning effort as Article 1. Never shorten later posts, simplify later photo briefs, recycle earlier outlines or cycle through templates because a project is large. Divide work into manageable batches while preserving IDs, editorial history, asset naming, SEO metadata, ad slots, affiliate slots and photo specifications.

## Aura JSON contract

Each imported post should include normal publishing data plus:

```json
{
  "protocol": "aura-17",
  "standard": "Mindful Adaption Standard v7 + Originality Engine",
  "editorial_fingerprint": {
    "angle": "",
    "opening_type": "",
    "architecture": "",
    "major_examples": [],
    "action_device": "",
    "closing_type": "",
    "featured_image_concept": ""
  },
  "internal_links": [
    {"title": "Verified destination", "url": "https://example.com/real-wordpress-url/"}
  ]
}
```

The full live prompt generated by Aura also includes the current batch brief, site voice, verified affiliate inventory, verified WordPress routing pool, editorial history, asset rules, image requirements and package-output instructions.

## Final standard

Privately ask:

> Would an editor believe this article was independently commissioned?

Then:

> Could the reader recognize this article’s identity if the title and primary keyword were temporarily hidden?

If either answer is no, replan and rewrite.
