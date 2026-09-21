// Aura ChatGPT Package Prompt — builds the full prompt that makes ChatGPT produce an Aura-ready ZIP.
(() => {
  const line = (label, v, fallback) => `- ${label}: ${String(v || '').trim() || fallback}`;
  function adBlock(ads) {
    const list = (ads || []).filter(a => a && a.enabled !== false && (a.url || a.html));
    if (!list.length) return `No ad links were supplied. For EVERY ad section still output the object with "slot" plus a context-matched "label", "text" and "cta", and set "url" to "" — Aura fills empty ad links from the Ad Library at publish time. Never delete or skip an ad section.`;
    return `Use these ad links. Rotate them across posts so neighbouring posts do not open with the same ad, and pick the most relevant one for each slot. Write fresh, context-matched "label", "text" and "cta" for each placement (do not change the URL):\n` +
      list.map((a, i) => `  ${i + 1}. ${a.name || a.label || 'Ad ' + (i + 1)} — URL: ${a.url || '(HTML ad unit — output url "" and Aura inserts the code)'}${a.label ? ` — default headline: "${a.label}"` : ''}${a.cta ? ` — default CTA: "${a.cta}"` : ''}`).join('\n') +
      `\nIf a slot has no fitting ad, still include it with url "" — Aura fills it automatically.`;
  }

  function build(cfg = {}) {
    const n = Math.max(1, Math.min(20, Number(cfg.count) || 5));
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `# AURA PUBLISHER — FULL-POST PACKAGE PROMPT (Mindful Adaption Standard v2)

You are a senior editor, SEO strategist and art director producing publish-ready blog posts for Aura Publisher, which imports your ZIP and publishes every post live to WordPress. Posts are NOT drafts: write finished, polished articles a reader would happily share.

## 1. Brief
${line('Site / brand', cfg.siteName, 'use a warm, trustworthy lifestyle-and-wellbeing brand voice')}
${line('Niche', cfg.niche, 'mindful living, personal growth and practical wellbeing')}
${line('Audience', cfg.audience, 'busy adults who want calm, practical, faith-friendly guidance without hype')}
${line('Voice', cfg.voice, 'warm, clear, grounded, encouraging; short paragraphs; second person ("you")')}
${line('Topics', cfg.topics, `choose ${n} distinct, search-worthy topics inside the niche with real reader intent`)}
- Number of posts: ${n}
- Package date code: ${today}

## 2. The Mindful Adaption Standard (required order for EVERY post)
1. **Featured image** (the "featured_image" object — never inside "sections")
2. **Relatable introduction** — type "intro", 90–150 words. Open with a specific moment, feeling or problem the reader recognises; end with a one-sentence promise of what they will get.
3. **Useful H2 sections** — 3 to 5 H2s. Each H2 has 150–260 words of genuinely useful guidance (paragraphs, plus optional "list" or "callout"). Optional H3s inside.
4. **Image slot #1** — type "image"
5. **Ad slot #1** — type "ad", slot "article-1"
6. **Practical examples** — one H2 whose heading clearly signals examples (e.g. "What this looks like on a real Tuesday", "Three real-life scenarios", "In practice"), 220–320 words with 2–3 concrete, named-situation examples.
7. **Image slot #2** — type "image"
8. **Ad slot #2** — type "ad", slot "article-2"
9. **Action checklist** — an H2 heading followed by one "checklist" section with 5–8 specific, verb-first items the reader can do this week.
10. **Closing takeaway** — an H2 whose heading contains a closing signal word (Takeaway, Bottom line, Final word, Before you go, Remember this) followed by one 70–120-word paragraph that lands one memorable idea.

Target a **7-minute read: 1,550–1,800 words** across all text sections. Count before you finish. Never pad; add depth, examples and specifics instead.

## 3. Make every post feel custom (variation rules)
Assign each post a different "format_variant" and let it shape tone, H2 style and rhythm while keeping the required order above:
- **story-led** — intro and H2s follow one person's arc
- **myth-vs-truth** — H2s correct common misconceptions
- **step-ladder** — H2s are progressive steps ("Step 1: …")
- **question-led** — H2s are the reader's real questions
- **framework** — introduce a named 3-part model and unpack it
- **science-to-life** — plain-English research insight → daily application
- **seasonal/timely** — anchored to a moment in the year or life stage
Across the batch: no two posts share the same intro hook type (question, micro-story, surprising fact, confession, vivid scene, bold claim); no two posts reuse the same H2 wording pattern; vary checklist length (5–8) and takeaway phrasing. Do not use: "In today's fast-paced world", "Let's dive in", "delve", "game-changer", "unlock your potential", "navigate the complexities", "it's important to note", "in conclusion". No fake statistics — only state figures you are confident are accurate, otherwise speak qualitatively.

Inline formatting allowed inside text: **bold**, *italic*, and [anchor text](https://full-url). Plain text otherwise (no HTML, no Markdown headings inside paragraphs).

## 4. Images — real images, every one with alt text
Every post has **1 featured image + 2 inline images** (3 minimum; a 3rd inline image inside a long H2 is allowed).
For each image provide:
- "filename": \`<post-slug>-featured.jpg\`, \`<post-slug>-inline-1.jpg\`, \`<post-slug>-inline-2.jpg\` (lowercase, hyphens, .jpg)
- "alt_text": follow the template **[Subject] [doing what] in [setting], [detail tied to the section/keyword]** — 80–125 characters, literal description, no "image of"/"picture of", include the primary keyword naturally in the featured image alt only.
- "caption": one short human sentence (optional but preferred)
- "purpose": "Featured image" or what the image supports
- "subject": 3–6 word subject summary
- "prompt": a detailed art-direction prompt (60–120 words): subject, action, setting, lighting, lens/composition, mood, colour palette; landscape 3:2 (1536×1024); photorealistic editorial style; diverse, natural-looking real people; **no text, letters, logos, watermarks or brand names in the image**.

**Generate the real images.** Use your image generation tool to create every image from its prompt, save each with its exact filename, and put them in the ZIP's \`images/\` folder. If your environment cannot place generated images into the ZIP, still deliver the ZIP with the complete manifest — Aura generates any missing image from its "prompt" automatically before publishing. Never reference a filename that has no prompt.

## 5. Ads — present in every story
Every post must contain exactly two ad sections in the positions above ("article-1" after image #1, "article-2" after image #2). Each ad section:
\`{"type":"ad","slot":"article-1","label":"<headline, max 60 chars>","text":"<one helpful sentence tying the offer to this section>","cta":"<2–4 word button text>","url":"<ad link>"}\`
${adBlock(cfg.ads)}
Ad copy must be honest, relevant to the surrounding section, and never disguised as editorial advice.

## 6. SEO fields
- "title": 45–60 characters, includes the primary keyword naturally, human not clickbait
- "slug": lowercase-hyphenated, 3–6 words
- "excerpt": 140–160 characters (used as meta description)
- "primary_keyword" + 3–5 "secondary_keywords" used naturally in intro, one H2 and the takeaway
- "categories": 1–2; "tags": 3–6
- "status": "publish"

## 7. Exact output format — aura-posts.json
\`\`\`json
{
  "protocol": "aura-11",
  "standard": "Mindful Adaption Standard",
  "generated": "${today}",
  "posts": [
    {
      "post_id": "aura-${today}-01-<short-slug>",
      "title": "…",
      "slug": "…",
      "excerpt": "…",
      "primary_keyword": "…",
      "secondary_keywords": ["…"],
      "format_variant": "story-led",
      "categories": ["…"],
      "tags": ["…"],
      "status": "publish",
      "featured_image": {"filename": "<slug>-featured.jpg", "alt_text": "…", "caption": "…", "purpose": "Featured image", "subject": "…", "prompt": "…"},
      "sections": [
        {"type": "intro", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "…"},
        {"type": "list", "items": ["…", "…"]},
        {"type": "callout", "label": "Try this", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "…"},
        {"type": "heading", "level": 2, "content": "…"},
        {"type": "paragraph", "content": "…"},
        {"type": "image", "filename": "<slug>-inline-1.jpg", "alt_text": "…", "caption": "…", "purpose": "…", "subject": "…", "prompt": "…"},
        {"type": "ad", "slot": "article-1", "label": "…", "text": "…", "cta": "…", "url": "…"},
        {"type": "heading", "level": 2, "content": "<examples heading>"},
        {"type": "paragraph", "content": "…"},
        {"type": "image", "filename": "<slug>-inline-2.jpg", "alt_text": "…", "caption": "…", "purpose": "…", "subject": "…", "prompt": "…"},
        {"type": "ad", "slot": "article-2", "label": "…", "text": "…", "cta": "…", "url": "…"},
        {"type": "heading", "level": 2, "content": "Your action checklist"},
        {"type": "checklist", "items": ["…", "…", "…", "…", "…"]},
        {"type": "heading", "level": 2, "content": "<takeaway heading>"},
        {"type": "paragraph", "content": "…"}
      ]
    }
  ]
}
\`\`\`
Allowed section types: intro, heading (level 2 or 3), paragraph, list, callout, image, ad, checklist. No other keys at the post level. Valid JSON only (double quotes, no comments, no trailing commas).

## 8. Package
Create **aura-package-${today}.zip** containing:
\`\`\`
aura-posts.json
images/<slug>-featured.jpg
images/<slug>-inline-1.jpg
images/<slug>-inline-2.jpg
…
\`\`\`
Do not include a CSV copy, README or validation files.

## 9. Self-check before you deliver (fix anything that fails)
For every post confirm:
- [ ] Order matches the Mindful Adaption Standard exactly (intro → 3–5 H2s → image → ad → examples H2 → image → ad → checklist H2 + checklist → takeaway H2 + paragraph)
- [ ] 1,550–1,800 words (≈7-minute read)
- [ ] featured_image + 2 inline images, each with filename, alt_text (80–125 chars), prompt
- [ ] 2 ad sections, slots article-1 and article-2, each with label, text, cta and url (url may be "" only if no ad links were supplied)
- [ ] Unique format_variant, intro hook, H2 wording and takeaway versus the other posts
- [ ] No banned phrases, no invented statistics, no text inside images
- [ ] JSON validates; every filename in the manifest exists in images/ (or has a prompt for Aura to generate)

Deliver: (1) the ZIP download link, (2) a one-line summary per post: title — format_variant — word count. Nothing else.`;
  }
  window.AuraPrompt = { build };
})();
