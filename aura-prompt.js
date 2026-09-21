// Aura ChatGPT Package Prompt V4 — builds batched prompts that make ChatGPT produce Aura-ready ZIP packages.
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
    const size = Math.max(1, Math.min(5, Number(cfg.batchSize) || 2));
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
    const photos = n.count * 3;
    return `# AURA PUBLISHER — FULL-POST PACKAGE PROMPT (Mindful Adaption Standard v4) — BATCH ${n.batchNo} OF ${n.batches}

You are a senior editor, SEO strategist, affiliate-content specialist and photo director. You produce finished, publish-ready blog posts and their real photographs for Aura Publisher, which imports your package, places the affiliate links and ads, and publishes every post live to WordPress. Write articles a reader would happily share and Google would want to rank.

## 0. How to deliver (follow exactly — this keeps you inside your reply and image limits)
**Reply 1 — the package.** Create **aura-package-${code}.zip** containing only \`aura-posts.json\` (no images folder). Give me the download link, then a numbered **Photo list** with one line per photo: \`Photo X of ${photos} — <filename> — <post title> — <where it goes>\`. Order: post 1 featured, post 1 inline-1, post 1 inline-2, then post 2, and so on.
**Then the photos, one per reply.** Generate **Photo 1** with your built-in image generation tool from its "prompt" field, as a real photorealistic photograph (landscape 3:2). Under the image write only \`Photo 1 of ${photos} — <filename>\`. Then stop. Each time I reply "next", generate the next photo the same way until Photo ${photos} is done.
**Never draw, paint or code an image** (no Python/PIL, matplotlib, SVG, canvas, shapes or placeholder art), and never put drawn images in the ZIP. If image generation is unavailable or you hit a limit, say "Photo X paused — limit reached" and wait; I will say "next" later. Do not substitute anything.
If the package would not fit in one reply, finish the current post, close the JSON validly, deliver the ZIP with the posts completed so far, and say which posts remain.

## 1. Brief
${line('Site / brand', cfg.siteName, 'a warm, trustworthy lifestyle-and-wellbeing brand')}
${line('Niche', cfg.niche, 'mindful living, personal growth and practical wellbeing')}
${line('Audience', cfg.audience, 'busy adults who want calm, practical, faith-friendly guidance without hype')}
${line('Voice', cfg.voice, 'warm, clear, grounded, encouraging; short paragraphs; second person ("you")')}
${clean(cfg.extra) ? `- Information and rules for EVERY post: ${clean(cfg.extra)}\n` : ''}- This batch: ${n.count} post${n.count > 1 ? 's' : ''} (batch ${n.batchNo} of ${n.batches}; posts ${firstNo}–${firstNo + n.count - 1} of ${pl.total}) · ${photos} photos
- Package code: ${code}

## 2. Posts in this batch
${topicBlock(batch, cfg, n)}

## 3. Search intent and SEO depth (do this before writing each post)
- Decide the searcher's intent (learn, compare, fix, buy) and answer it fully; the post must be the most useful result for its primary keyword.
- **Direct answer:** the first paragraph under the first H2 is a 40–60-word plain answer to the main question (featured-snippet ready).
- Use the primary keyword in the title, slug, first 100 words, one H2, the meta description and the takeaway. Use each secondary keyword naturally once or twice. Weave in 8–12 related terms and entities a real expert would mention (tools, materials, techniques, seasons, measurements, common mistakes).
- H2s read like the questions and tasks people actually search for; include at least one "how to", one "why" or "what" and one "mistakes"/"avoid" angle where it fits.
- Show experience: concrete details, numbers you are sure of (quantities, times, sizes, temperatures), sensory specifics and honest trade-offs. No invented statistics, studies, quotes or experts.
- FAQ: 4–6 real questions people ask about the topic (the "People also ask" kind), each answered in 40–80 words, without repeating body text.

## 4. The Mindful Adaption Standard v4 (required order for EVERY post)
1. **Featured image** — the "featured_image" object (never inside "sections")
2. **Relatable introduction** — type "intro", 90–150 words: a specific moment, feeling or problem the reader recognises, then a one-sentence promise.
3. **Key takeaways** — type "takeaways", 3–5 short, specific bullet sentences (what the reader will be able to do).
4. **Useful H2 sections** — 3 to 5 H2s, each 180–280 words (at least two are 250+ words). Mix in the rich blocks below so the page never feels blank.
5. **Image slot #1** — type "image"
6. **Ad slot #1** — type "ad", slot "article-1"
7. **Practical examples** — one H2 that clearly signals examples ("Three real-life scenarios", "In practice", "What this looks like on a real Tuesday"), 220–320 words, 2–3 concrete named situations.
8. **Image slot #2** — type "image"
9. **Ad slot #2** — type "ad", slot "article-2"
10. **FAQ** — one "faq" section with 4–6 items.
11. **Action checklist** — H2 + one "checklist" with 5–8 specific, verb-first items for this week.
12. **Closing takeaway** — H2 containing Takeaway, Bottom line, Final word, Before you go or Remember this + one 70–120-word paragraph that lands one memorable idea.

**Rich blocks — each post uses all of these at least once, spread through the H2 sections:** a "callout" (tone "tip"), a second "callout" (tone "note", "warning" or "example"), one "pullquote" (a line from your own text worth highlighting — never a fake quote from a real person), one "list" (bullets) and one ordered "list" ("ordered": true) for steps. Keep paragraphs to 2–4 sentences.
Target a **7–8 minute read: 1,650–1,950 words** including the FAQ. Never pad; add depth, specifics and examples.

## 5. Make every post custom
Give each post a different "format_variant" that shapes tone, H2 style and rhythm: story-led · myth-vs-truth · step-ladder · question-led · framework · science-to-life · seasonal/timely · checklist-deep-dive · mistakes-to-avoid · before-and-after.
Every post is written from scratch for its own topic — never reuse paragraphs, section text, examples, FAQ answers or checklist items from another post with the keyword swapped. No two posts (in this batch or earlier batches of this conversation) share an intro hook type, H2 wording pattern, checklist opening verb or takeaway phrasing. Banned: "In today's fast-paced world", "Let's dive in", "delve", "game-changer", "unlock your potential", "navigate the complexities", "it's important to note", "in conclusion", "elevate".
Inline formatting inside text: **bold** (2–4 key phrases per post), *italic*, [anchor](https://url) for editorial links, [anchor](aff:ID) for affiliate links. No HTML, no Markdown headings inside text.

## 6. Affiliate links and ads — placed where they genuinely fit
${affiliateBlock(cfg.ads)}

Rules:
- **In-text links:** 2–4 per post as [natural anchor text](aff:ID) inside paragraphs where the product truly helps at that moment. Each ID at most once per post. Never in the intro's first two sentences, headings, takeaways, FAQ, checklist or closing takeaway. Anchors are descriptive (2–5 words), never "click here" or "buy now".
- **Ad sections (article-1, article-2):** set "ad_id" to the best-fitting ID for that section and write fresh "label" (max 60 chars), "text" (one honest sentence tying the product to THIS section) and "cta" (2–4 words). Leave "url" as "". Use different IDs in the two slots when possible.
- **Featured IDs:** when a post in section 2 lists affiliate IDs, feature each at least once in that post.
- If nothing fits a section, write "ad_id": "" — Aura picks the most relevant one. Never force an irrelevant product. Aura adds labels, banner, side cards, resources list and disclosure itself; do not write disclosures.

## 7. Photos — real people, real connection, matched to their exact spot
Every post has **1 featured photo + 2 inline photos**. **Every photo shows real people sharing a genuine human moment** — a parent guiding a child's hands, friends laughing over a task, neighbours helping each other, a couple proud of what they made. Real emotion on faces and in hands: relief, pride, encouragement, joy, calm focus. No empty rooms, no product-only shots, no stock smiles at the camera. Each inline photo acts out the specific idea of the section it sits in.

**Featured photo = premium magazine cover.** Vibrant, abundant, richly detailed lifestyle scene in warm natural light, layered foreground to background, with the post's short headline in large, bold, hand-painted brush-script lettering integrated into the photo. Put that headline (max 7 words, spelled exactly) in "hero_text". For "vs", "buy vs skip", "mistakes" or before-and-after topics, use a split scene: the bright, hopeful right way on one side (with the people), the darker wrong way on the other.
**Inline photos = no text at all**, candid and photojournalistic.

Build a private shot list for the batch first and give every photo a different combination of people + relationship + emotion, action from its section, specific setting (never repeated in the batch), shot (featured wide scene · inline-1 medium candid of two people · inline-2 close-up of hands working together with faces softly in frame), time of day and matching light, lens (24–35mm wide, 50mm, 85mm) and a rich natural palette.

Fields for every photo:
- "filename": \`<post-slug>-featured.jpg\`, \`<post-slug>-inline-1.jpg\`, \`<post-slug>-inline-2.jpg\`
- "alt_text": **[Who] [doing what] in [setting]** — 80–125 characters, complete (never cut mid-word), unique; primary keyword only in the featured alt
- "caption": one short human sentence, unique per photo
- "purpose", "subject" (3–6 words), "concept", "people", "emotion", "shot", "setting", "time_of_day", "lighting", "lens", "palette": short phrases from your shot list
- "prompt": 90–150 words, a photographer's brief: "Photorealistic, vibrant editorial lifestyle photograph. [shot] of [people] [action] in [setting], [time of day], [lighting]. Human connection: [emotion], candid, not looking at the camera. Shot on a full-frame camera with a [lens]; layered composition with [3 real props] in the foreground. [palette]. [mood]. Natural skin texture, realistic hands with five fingers, true-to-life colour, rich detail. Not an illustration, cartoon, vector or 3D render." Inline prompts add "No text, letters or logos anywhere"; the featured prompt adds "The only text is the headline "[hero_text]", spelled exactly". Landscape 3:2.
- Every prompt is written for its own photo. Never reuse a prompt template across posts.

## 8. SEO fields (every post)
- "title": 50–60 characters, primary keyword near the start, specific benefit, human not clickbait
- "meta_title": ≤ 60 characters (may equal the title or add a brand/benefit)
- "meta_description": 140–155 characters, one or two complete sentences with the primary keyword and a clear reason to click; never cut off
- "excerpt": 25–40 words, a complete teaser written differently from the meta description (shown on blog and category pages)
- "focus_keyphrase": the primary keyword exactly
- "slug": lowercase-hyphenated, 3–6 words, primary keyword included
- "primary_keyword" + 3–5 "secondary_keywords" · "categories": 1–2 · "tags": 4–6 specific tags · "status": "publish"

## 9. Exact output — aura-posts.json
\`\`\`json
{
  "protocol": "aura-11.3",
  "standard": "Mindful Adaption Standard v4",
  "generated": "${code}",
  "posts": [
    {
      "post_id": "aura-${code}-01-<short-slug>",
      "title": "…", "slug": "…", "meta_title": "…", "meta_description": "…", "excerpt": "…",
      "focus_keyphrase": "…", "primary_keyword": "…", "secondary_keywords": ["…"],
      "format_variant": "story-led", "categories": ["…"], "tags": ["…"], "status": "publish",
      "hero_text": "<short headline, max 7 words>",
      "featured_image": {"filename": "<slug>-featured.jpg", "alt_text": "…", "caption": "…", "purpose": "Featured image", "subject": "…", "concept": "…", "people": "…", "emotion": "…", "shot": "…", "setting": "…", "time_of_day": "…", "lighting": "…", "lens": "…", "palette": "…", "prompt": "…"},
      "sections": [
        {"type": "intro", "content": "…"},
        {"type": "takeaways", "items": ["…", "…", "…"]},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "<40–60-word direct answer>"},
        {"type": "paragraph", "content": "… a [descriptive anchor](aff:<ID>) where it truly helps …"},
        {"type": "callout", "tone": "tip", "label": "Try this", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "…"},
        {"type": "list", "ordered": true, "items": ["…", "…", "…"]},
        {"type": "pullquote", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "…"},
        {"type": "list", "items": ["…", "…"]},
        {"type": "callout", "tone": "warning", "label": "Watch out", "content": "…"},
        {"type": "image", "filename": "<slug>-inline-1.jpg", "alt_text": "…", "caption": "…", "purpose": "…", "subject": "…", "concept": "…", "people": "…", "emotion": "…", "shot": "…", "setting": "…", "time_of_day": "…", "lighting": "…", "lens": "…", "palette": "…", "prompt": "…"},
        {"type": "ad", "slot": "article-1", "ad_id": "<ID or empty>", "label": "…", "text": "…", "cta": "…", "url": ""},
        {"type": "heading", "level": 2, "content": "<examples heading>"},
        {"type": "paragraph", "content": "…"},
        {"type": "image", "filename": "<slug>-inline-2.jpg", "…": "same fields as above"},
        {"type": "ad", "slot": "article-2", "ad_id": "<ID or empty>", "label": "…", "text": "…", "cta": "…", "url": ""},
        {"type": "faq", "items": [{"q": "…?", "a": "…"}, {"q": "…?", "a": "…"}]},
        {"type": "heading", "level": 2, "content": "Your action checklist"},
        {"type": "checklist", "items": ["…", "…", "…", "…", "…"]},
        {"type": "heading", "level": 2, "content": "<takeaway heading>"},
        {"type": "paragraph", "content": "…"}
      ]
    }
  ]
}
\`\`\`
Allowed section types: intro, takeaways, heading (level 2 or 3), paragraph, list, callout (tone tip/note/warning/example), pullquote, image, ad, faq, checklist. Valid JSON only (double quotes, no comments, no trailing commas). Number post_ids 01, 02… within this batch.

## 10. Self-check before you deliver (fix anything that fails)
For every post:
- [ ] Standard v4 order exact; 1,650–1,950 words; at least two H2 sections of 250+ words
- [ ] Direct 40–60-word answer under the first H2; primary keyword in title, slug, first 100 words, one H2, meta description, takeaway
- [ ] title 50–60 chars · meta_title ≤ 60 · meta_description 140–155 complete · excerpt 25–40 words complete and different · focus_keyphrase set
- [ ] takeaways, 2 callouts, 1 pullquote, 1 bullet list, 1 ordered list, FAQ with 4–6 items
- [ ] 2–4 [anchor](aff:ID) links using only IDs from section 6; 2 ad sections with ad_id, label, text, cta and url ""
- [ ] 3 photos with every field and real people sharing a genuine moment; nothing repeated across the batch; unique complete alt text; featured has hero_text
- [ ] Unique format_variant, hook, H2 pattern and takeaway versus every other post; no banned phrases, invented facts or reused text
- [ ] ZIP contains only aura-posts.json; no drawn images anywhere

Deliver Reply 1 as described in section 0: (1) the ZIP link, (2) one line per post: title — format_variant — word count — affiliate IDs used, (3) the Photo list. Then generate Photo 1.${n.batchNo < n.batches ? `\nWhen all ${photos} photos are done, I will paste batch ${n.batchNo + 1}.` : ''}`;
  }

  function buildAll(cfg = {}) {
    const pl = plan(cfg);
    return pl.batches.map((_, i) => build(cfg, i)).join('\n\n---\n\n');
  }

  window.AuraPrompt = { build, buildAll, plan, parseTopics, adId };
})();
