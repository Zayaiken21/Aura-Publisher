// Aura ChatGPT Package Prompt V3 — builds batched prompts that make ChatGPT produce Aura-ready ZIP packages.
// Unlimited post lists are split into batches ChatGPT can finish in one reply (no truncated JSON, no rate limits).
(() => {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/-$/, '');
  const adId = a => slug(a.id || a.name || a.label || 'ad');
  const list = v => Array.isArray(v) ? v.map(clean).filter(Boolean) : String(v || '').split(/[,;]/).map(clean).filter(Boolean);

  // "Title | keyword | notes | affiliate ids" — one per line. Bare lines are titles/topics.
  function parseTopics(text) {
    return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
      const [topic, keyword, notes, affs] = l.split('|').map(clean);
      return { topic, keyword: keyword || '', notes: notes || '', affiliates: list(affs).map(slug) };
    }).filter(t => t.topic);
  }

  function plan(cfg = {}) {
    const topics = parseTopics(cfg.topics);
    const size = Math.max(1, Math.min(5, Number(cfg.batchSize) || 3));
    const total = topics.length || Math.max(1, Math.min(200, Number(cfg.count) || 5));
    const batches = [];
    for (let i = 0; i < total; i += size) batches.push(topics.length ? topics.slice(i, i + size) : Array.from({ length: Math.min(size, total - i) }, () => null));
    return { topics, size, total, batches };
  }

  const line = (label, v, fallback) => `- ${label}: ${clean(v) || fallback}`;

  function affiliateBlock(ads) {
    const lib = (ads || []).filter(a => a && a.enabled !== false && (a.url || a.html));
    if (!lib.length) return `No affiliate links are loaded yet. Still write both ad sections with a context-matched "label", "text" and "cta", set "ad_id" to "" and "url" to "" — Aura fills them from its library at publish time. Do not write any aff: links.`;
    return `These are the ONLY affiliate products/offers available. Refer to them by ID; never invent products, prices, discounts, ratings or claims about them.
| ID | Product / offer | Fits topics about | Default button |
|---|---|---|---|
${lib.map(a => `| ${adId(a)} | ${clean(a.label || a.name)}${a.text ? ` — ${clean(a.text)}` : ''} | ${list(a.keywords).join(', ') || clean(a.category) || 'general'} | ${clean(a.cta) || 'Learn more'} |`).join('\n')}`;
  }

  function topicBlock(batch, cfg, n) {
    if (!batch.some(Boolean)) return `Choose ${batch.length} distinct, search-worthy topic${batch.length > 1 ? 's' : ''} inside the niche with real reader intent${n.batchNo > 1 ? `, different from anything you wrote in earlier batches of this conversation` : ''}.`;
    return `Write exactly these ${batch.length} post${batch.length > 1 ? 's' : ''}, in this order. Use every detail given; the notes are facts and angles you must include.\n` +
      batch.map((t, i) => `${i + 1}. **${t.topic}**${t.keyword ? ` — primary keyword: "${t.keyword}"` : ''}${t.notes ? ` — notes: ${t.notes}` : ''}${t.affiliates.length ? ` — feature affiliate IDs: ${t.affiliates.join(', ')}` : ''}`).join('\n');
  }

  function build(cfg = {}, batchIndex = 0) {
    const pl = plan(cfg);
    const bi = Math.max(0, Math.min(pl.batches.length - 1, Number(batchIndex) || 0));
    const batch = pl.batches[bi];
    const n = { batchNo: bi + 1, batches: pl.batches.length, count: batch.length };
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const code = `${today}-b${String(n.batchNo).padStart(2, '0')}`;
    const firstNo = bi * pl.size + 1;
    return `# AURA PUBLISHER — FULL-POST PACKAGE PROMPT (Mindful Adaption Standard v3) — BATCH ${n.batchNo} OF ${n.batches}

You are a senior editor, SEO strategist, affiliate-content specialist and photo director. You produce finished, publish-ready blog posts for Aura Publisher, which imports your ZIP, places the affiliate links and ads, generates any missing photos and publishes every post live to WordPress. Write articles a reader would happily share.

## 1. Brief
${line('Site / brand', cfg.siteName, 'a warm, trustworthy lifestyle-and-wellbeing brand')}
${line('Niche', cfg.niche, 'mindful living, personal growth and practical wellbeing')}
${line('Audience', cfg.audience, 'busy adults who want calm, practical, faith-friendly guidance without hype')}
${line('Voice', cfg.voice, 'warm, clear, grounded, encouraging; short paragraphs; second person ("you")')}
${clean(cfg.extra) ? `- Information and rules for EVERY post: ${clean(cfg.extra)}\n` : ''}- This batch: ${n.count} post${n.count > 1 ? 's' : ''} (batch ${n.batchNo} of ${n.batches}; posts ${firstNo}–${firstNo + n.count - 1} of ${pl.total})
- Package code: ${code}

## 2. Posts in this batch
${topicBlock(batch, cfg, n)}

## 3. The Mindful Adaption Standard (required order for EVERY post)
1. **Featured image** — the "featured_image" object, never inside "sections"
2. **Relatable introduction** — type "intro", 90–150 words. Open with a specific moment, feeling or problem the reader recognises; end with a one-sentence promise.
3. **Useful H2 sections** — 3 to 5 H2s, each 180–280 words of genuinely useful guidance (paragraphs, plus optional "list", "callout" or H3s). Write at least two of them long (250+ words): Aura places side ads beside long sections.
4. **Image slot #1** — type "image"
5. **Ad slot #1** — type "ad", slot "article-1"
6. **Practical examples** — one H2 that clearly signals examples ("What this looks like on a real Tuesday", "Three real-life scenarios", "In practice"), 220–320 words, 2–3 concrete named-situation examples.
7. **Image slot #2** — type "image"
8. **Ad slot #2** — type "ad", slot "article-2"
9. **Action checklist** — H2 heading + one "checklist" section with 5–8 specific, verb-first items for this week.
10. **Closing takeaway** — H2 containing a closing word (Takeaway, Bottom line, Final word, Before you go, Remember this) + one 70–120-word paragraph that lands one memorable idea.

Target a **7-minute read: 1,550–1,800 words** of text per post. Count before you finish. Never pad; add depth, specifics and examples.

## 4. Make every post custom
Give each post a different "format_variant" that shapes tone, H2 style and rhythm (keep the required order): story-led · myth-vs-truth · step-ladder · question-led · framework · science-to-life · seasonal/timely · checklist-deep-dive · mistakes-to-avoid · before-and-after.
Every post is written from scratch for its own topic — never reuse paragraphs, section text, examples or checklist items from another post with the keyword swapped. No two posts (in this batch or earlier batches of this conversation) share an intro hook type, H2 wording pattern, checklist opening verb or takeaway phrasing. Banned: "In today's fast-paced world", "Let's dive in", "delve", "game-changer", "unlock your potential", "navigate the complexities", "it's important to note", "in conclusion", "elevate". No invented statistics, quotes, studies or experts — state figures only when you are sure they are accurate, otherwise speak qualitatively.
Inline formatting inside text: **bold**, *italic*, [anchor](https://url) for editorial links, and [anchor](aff:ID) for affiliate links. No HTML, no Markdown headings inside text.

## 5. Affiliate links and ads — placed where they genuinely fit
${affiliateBlock(cfg.ads)}

Rules:
- **In-text links:** in each post place 2–4 affiliate links as [natural anchor text](aff:ID) inside paragraphs where the product truly helps the reader at that moment (e.g. "a [weighted blanket](aff:calm-weighted-blanket) can make the wind-down easier"). Each ID at most once per post. Never in the intro's first two sentences, headings, the checklist or the takeaway. Anchor text is a descriptive phrase (2–5 words), never "click here" or "buy now".
- **Ad sections (article-1, article-2):** set "ad_id" to the best-fitting ID for that section's topic, and write fresh "label" (max 60 chars), "text" (one honest sentence tying the product to THIS section) and "cta" (2–4 words). Leave "url" as "" — Aura inserts the real link. Two ad sections in one post use different IDs when possible.
- **Featured IDs:** when a post in section 2 lists affiliate IDs, feature each of them at least once in that post (in-text or ad section).
- If no product fits a section, write "ad_id": "" — Aura picks the most relevant one. Never force an irrelevant product.
- Aura adds the "Sponsored" labels, the top banner, side cards, the resources list and the disclosure itself, with sponsored/nofollow links. Do not write disclosures or "affiliate" wording yourself, and never present an ad as editorial advice.

## 6. Photos — real people, real connection, matched to their exact spot
Every post has **1 featured image + 2 inline images** (a 3rd inline image inside a long H2 is allowed). **Every image shows real people sharing a genuine human moment** — a parent guiding a child's hands, friends laughing over a task, neighbours helping each other, a couple proud of what they made. Faces and hands show real emotion: relief, pride, encouragement, joy, calm focus. No empty rooms, no product-only shots, no stock-photo smiles at the camera. Each image must show the specific idea of the section it sits in, acted out by the people in it.

**Featured image = premium magazine cover.** Vibrant, abundant, richly detailed lifestyle scene in warm natural sunlight, layered foreground to background (think a styled editorial spread), with the post's short headline in large, bold, hand-painted brush-script lettering integrated into the image. Put that headline (max 7 words, spelled exactly) in "hero_text". For "vs", "buy vs skip", "mistakes" or before-and-after topics, use a split scene: the bright, hopeful right way on one side (with the people), the darker wrong way on the other.

**Inline images = no text at all**, photojournalistic and candid.

Before writing the image fields, build a private shot list for the whole batch and give every image a different combination of:
- **people + connection** — who (vary age, gender, ethnicity, body type and relationship: family, friends, neighbours, couples, mentor and learner) and the emotion between them
- **action** — the exact thing from its section they are doing (e.g. "checking soil moisture with a finger", not "gardening")
- **setting** — a specific, real place (never the same setting twice in the batch)
- **shot** — featured: wide environmental scene; inline #1: medium candid of two people; inline #2: close-up of hands working together with faces softly in frame
- **time_of_day** and **lighting** that agree (morning window light, golden-hour backlight, dappled shade, lamp light at dusk)
- **lens** — 24–35mm wide, 50mm natural, 85mm portrait
- **palette** — rich, natural colours that differ between images

Fields for every image:
- "filename": \`<post-slug>-featured.jpg\`, \`<post-slug>-inline-1.jpg\`, \`<post-slug>-inline-2.jpg\` (lowercase, hyphens, .jpg)
- "alt_text": **[Who] [doing what] in [setting]** — 80–125 characters, literal and complete (never cut mid-word), unique for every image, no "image of"; primary keyword only in the featured alt
- "caption": one short human sentence, unique per image (or leave it out)
- "purpose", "subject" (3–6 words), "concept", "people", "emotion", "shot", "setting", "time_of_day", "lighting", "lens", "palette": short phrases from your shot list
- "prompt": 90–150 words written like a photographer's brief: "Photorealistic, vibrant editorial lifestyle photograph. [shot] of [people] [action] in [setting], [time of day], [lighting]. Human connection: [emotion], candid, not looking at the camera. Shot on a full-frame camera with a [lens]; layered composition with [3 real props] in the foreground. [palette]. [mood]." End with: "Natural skin texture, realistic hands with five fingers, true-to-life colour, rich detail. Not an illustration, cartoon, vector or 3D render." Inline prompts add "No text, letters or logos anywhere"; the featured prompt adds "The only text is the headline, spelled exactly". Landscape 3:2 (1536×1024).
- Every prompt must be written for its own image. Never reuse a prompt template across posts.

**Images: real photos or none.** Generate each image with your image generation tool as a photorealistic photo and put it in the ZIP's \`images/\` folder under its exact filename. **Never draw, paint or code images yourself (no Python/PIL, SVG, canvas, shapes or placeholder art).** If you cannot generate real photos, leave the \`images/\` folder empty and deliver the manifest only — Aura generates every missing photo from your fields, and it automatically discards drawn placeholder images.

## 7. SEO fields
- "title": 45–60 characters, primary keyword included naturally, human not clickbait
- "slug": lowercase-hyphenated, 3–6 words
- "excerpt": 140–160 characters (meta description)
- "primary_keyword" + 3–5 "secondary_keywords", used naturally in the intro, one H2 and the takeaway
- "categories": 1–2 · "tags": 3–6 · "status": "publish"

## 8. Exact output — aura-posts.json
\`\`\`json
{
  "protocol": "aura-11.2",
  "standard": "Mindful Adaption Standard",
  "generated": "${code}",
  "posts": [
    {
      "post_id": "aura-${code}-01-<short-slug>",
      "title": "…", "slug": "…", "excerpt": "…",
      "primary_keyword": "…", "secondary_keywords": ["…"],
      "format_variant": "story-led",
      "categories": ["…"], "tags": ["…"], "status": "publish",
      "hero_text": "<short headline, max 7 words>",
      "featured_image": {"filename": "<slug>-featured.jpg", "alt_text": "…", "caption": "…", "purpose": "Featured image", "subject": "…", "concept": "…", "people": "…", "emotion": "…", "shot": "…", "setting": "…", "time_of_day": "…", "lighting": "…", "lens": "…", "palette": "…", "prompt": "…"},
      "sections": [
        {"type": "intro", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "… a [descriptive anchor](aff:<ID>) where it truly helps …"},
        {"type": "list", "items": ["…", "…"]},
        {"type": "callout", "label": "Try this", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "…"},
        {"type": "image", "filename": "<slug>-inline-1.jpg", "alt_text": "…", "caption": "…", "purpose": "…", "subject": "…", "concept": "…", "people": "…", "emotion": "…", "shot": "…", "setting": "…", "time_of_day": "…", "lighting": "…", "lens": "…", "palette": "…", "prompt": "…"},
        {"type": "ad", "slot": "article-1", "ad_id": "<ID or empty>", "label": "…", "text": "…", "cta": "…", "url": ""},
        {"type": "heading", "level": 2, "content": "<examples heading>"},
        {"type": "paragraph", "content": "…"},
        {"type": "image", "filename": "<slug>-inline-2.jpg", "alt_text": "…", "caption": "…", "purpose": "…", "subject": "…", "concept": "…", "people": "…", "emotion": "…", "shot": "…", "setting": "…", "time_of_day": "…", "lighting": "…", "lens": "…", "palette": "…", "prompt": "…"},
        {"type": "ad", "slot": "article-2", "ad_id": "<ID or empty>", "label": "…", "text": "…", "cta": "…", "url": ""},
        {"type": "heading", "level": 2, "content": "Your action checklist"},
        {"type": "checklist", "items": ["…", "…", "…", "…", "…"]},
        {"type": "heading", "level": 2, "content": "<takeaway heading>"},
        {"type": "paragraph", "content": "…"}
      ]
    }
  ]
}
\`\`\`
Allowed section types: intro, heading (level 2 or 3), paragraph, list, callout, image, ad, checklist. Valid JSON only (double quotes, no comments, no trailing commas). Number post_ids 01, 02… within this batch.

## 9. Package
Create **aura-package-${code}.zip** containing \`aura-posts.json\` and \`images/<filename>\` for every image. Nothing else.

## 10. Self-check before you deliver (fix anything that fails)
For every post:
- [ ] Standard order exact: intro → 3–5 H2s → image → ad → examples H2 → image → ad → checklist H2 + checklist → takeaway H2 + paragraph
- [ ] 1,550–1,800 words; at least two H2 sections of 250+ words
- [ ] 2–4 [anchor](aff:ID) links using only IDs from section 5, each placed where it genuinely helps; listed feature IDs used
- [ ] 2 ad sections (article-1, article-2) with ad_id, label, text, cta and url ""
- [ ] 3 images, each with every field and real people sharing a genuine moment; no setting, shot, action or time-of-day repeated anywhere in the batch; each prompt written for its own section; unique, complete alt text
- [ ] Featured image has hero_text and the magazine-cover direction; inline images have no text
- [ ] No drawn, coded or placeholder images in the ZIP (real generated photos, or an empty images/ folder)
- [ ] Unique format_variant, hook, H2 pattern and takeaway versus every other post in this conversation
- [ ] No banned phrases, invented facts or text in images; JSON validates

Deliver: (1) the ZIP download link, (2) one line per post: title — format_variant — word count — affiliate IDs used.${n.batchNo < n.batches ? `\nWhen I reply "next", I will paste batch ${n.batchNo + 1}.` : ''}`;
  }

  function buildAll(cfg = {}) {
    const pl = plan(cfg);
    return pl.batches.map((_, i) => build(cfg, i)).join('\n\n---\n\n');
  }

  window.AuraPrompt = { build, buildAll, plan, parseTopics, adId };
})();
