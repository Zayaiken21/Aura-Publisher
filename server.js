// Aura Publisher Pro — API 5.0.0 (V11)
// Mindful Adaption Standard enforcement, real publishing (publish / schedule / pending / draft),
// idempotent upserts, ad-slot filling, alt-text templating, AI image generation, WP retry/backoff.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import AdmZip from 'adm-zip';

const API_VERSION = '5.0.0';
const PROTOCOL = '11.0';
const PORT = process.env.PORT || 8787;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy; required for correct per-client rate limiting.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 200, fieldSize: 12 * 1024 * 1024 }
});

// ---------- CORS / security / rate limits ----------
const cleanOrigin = x => String(x || '').trim().replace(/\/+$/, '');
const origins = [...new Set(['https://zayaiken21.github.io', ...(process.env.ALLOWED_ORIGINS || '').split(',')].map(cleanOrigin).filter(Boolean))];
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || origins.includes(cleanOrigin(origin))) return cb(null, true);
    console.warn('Blocked CORS origin:', origin);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
  exposedHeaders: ['Retry-After', 'RateLimit', 'RateLimit-Policy'],
  optionsSuccessStatus: 204
};
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '25mb' }));

const isHealth = req => req.method === 'OPTIONS' || req.path === '/healthz' || req.path === '/health' || req.path === '/';
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, skip: isHealth,
  message: { error: 'Too many requests to Aura Engine. Wait a minute and try again.', code: 'aura_rate_limited' } }));
const imageLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Image generation is cooling down. Aura will retry automatically.', code: 'image_rate_limited' } });

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fetchTimed = (url, opts = {}, ms = 20000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms), redirect: 'follow' });
const parseBody = async r => { const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch { return { raw: t.slice(0, 500) }; } };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeEntities = s => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;|&rsquo;/g, "'").replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 90).replace(/-$/, '');
const arr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : String(v || '').split(/[|;,]/).map(x => x.trim()).filter(Boolean);
const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] != null && o[k] !== '') return o[k]; return ''; };
const clip = (s, n) => { s = String(s || '').trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; };
const lc = s => String(s || '').replace(/\\/g, '/').split('/').pop().trim().toLowerCase();
const stripHtml = s => String(s || '').replace(/<[^>]+>/g, ' ');
const countWords = s => (stripHtml(s).match(/[\p{L}\p{N}'’-]+/gu) || []).length;
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const mimeFor = n => { n = String(n).toLowerCase(); return n.endsWith('.png') ? 'image/png' : n.endsWith('.webp') ? 'image/webp' : n.endsWith('.gif') ? 'image/gif' : 'image/jpeg'; };
const asciiName = n => String(n || 'image.jpg').normalize('NFKD').replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-') || 'image.jpg';

// ---------- WordPress ----------
const normalizeWpUrl = value => {
  let v = String(value || '').trim(); if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  const u = new URL(v);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/(wp-admin|wp-login\.php|wp-json).*$/i, '').replace(/\/$/, '')}`;
};
const authHeader = w => `Basic ${Buffer.from(`${w.username}:${String(w.appPassword || '').replace(/\s+/g, '')}`).toString('base64')}`;
const discoverCache = new Map(); // site -> {root, t}

async function discoverWp(w) {
  const site = normalizeWpUrl(w.url);
  if (!site) throw Object.assign(new Error('Enter your WordPress Site URL.'), { code: 'missing_site' });
  const cached = discoverCache.get(site);
  if (cached && Date.now() - cached.t < 10 * 60_000) return { site, root: cached.root };
  let discovered = '';
  try {
    const h = await fetchTimed(site, { method: 'HEAD' });
    const m = (h.headers.get('link') || '').match(/<([^>]+)>;\s*rel=["']?https:\/\/api\.w\.org\/["']?/i);
    if (m) discovered = m[1];
  } catch {}
  for (const root of [discovered, `${site}/wp-json/`, `${site}/?rest_route=/`].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i)) {
    try {
      const r = await fetchTimed(root, { headers: { Accept: 'application/json' } }), j = await parseBody(r);
      if (r.ok && (j.namespaces?.includes?.('wp/v2') || (j.routes && Object.keys(j.routes).some(k => k.startsWith('/wp/v2'))))) {
        const clean = root.endsWith('/') ? root : root + '/';
        discoverCache.set(site, { root: clean, t: Date.now() });
        return { site, root: clean };
      }
    } catch {}
  }
  throw Object.assign(new Error('WordPress REST API was not found. Re-save Settings → Permalinks and check security/cache plugins.'), { code: 'rest_not_found' });
}

// Fixes query strings on ?rest_route= sites (the second "?" must become "&").
function routeUrl(root, path) {
  const [p, q] = String(path).replace(/^\//, '').split(/\?(.*)/s);
  if (root.includes('rest_route=')) return `${root}wp/v2/${p}${q ? '&' + q : ''}`;
  return `${root}wp/v2/${p}${q ? '?' + q : ''}`;
}

async function wpFetch(w, path, opts = {}, attempt = 0) {
  const d = w.restRoot ? { root: w.restRoot } : await discoverWp(w);
  const url = routeUrl(d.root, path);
  const method = (opts.method || 'GET').toUpperCase();
  let r;
  try {
    r = await fetchTimed(url, { ...opts, headers: { Accept: 'application/json', Authorization: authHeader(w), ...(opts.headers || {}) } }, opts.timeout || 60000);
  } catch (e) {
    if (method === 'GET' && attempt < 2) { await sleep(1500 * (attempt + 1)); return wpFetch(w, path, opts, attempt + 1); }
    throw Object.assign(new Error(`Could not reach WordPress (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`), { code: 'wp_network', url });
  }
  const j = await parseBody(r);
  if ([429, 502, 503, 504].includes(r.status) && attempt < 3) {
    const ra = Number(r.headers.get('retry-after')) || 0;
    await sleep(Math.min(30000, ra ? ra * 1000 : 2000 * 2 ** attempt));
    return wpFetch(w, path, opts, attempt + 1);
  }
  if (!r.ok) throw Object.assign(new Error(j.message || `WordPress returned ${r.status}`), { status: r.status, wpCode: j.code, data: j.data, url });
  return j;
}

function wpError(e) {
  let message = e.message || 'WordPress connection failed.';
  if (e.status === 401 || ['rest_not_logged_in', 'incorrect_password', 'invalid_username', 'invalid_email'].includes(e.wpCode))
    message = 'WordPress authentication failed. Use your WordPress login username and a valid Application Password (Users → Profile → Application Passwords).';
  else if (['rest_cannot_publish', 'rest_cannot_create', 'rest_cannot_edit'].includes(e.wpCode))
    message = 'This WordPress user is not allowed to publish. Use an Author, Editor or Administrator account, or publish as "Pending review".';
  else if (['rest_upload_sniffed_bad_content_type', 'rest_upload_file_type_not_allowed'].includes(e.wpCode) || /file type/i.test(message))
    message = `WordPress rejected an image file: ${message}`;
  else if (e.status === 403) message = 'WordPress blocked access. Check the user role and security/firewall plugins (they often block REST uploads).';
  else if (e.status === 404 || e.wpCode === 'rest_no_route') message = 'WordPress REST route was not found.';
  else if (e.status === 413) message = 'WordPress rejected the upload as too large. Raise upload_max_filesize or use smaller images.';
  return { error: message, code: e.wpCode || e.code || 'wordpress_error', status: e.status || 400, url: e.url || null };
}

// ---------- normalization ----------
function normalizeAd(s) {
  return { type: 'ad', slot: String(s.slot || ''), label: pick(s, 'label', 'headline', 'title'), url: pick(s, 'url', 'link', 'href'), cta: pick(s, 'cta', 'button'), text: pick(s, 'text', 'content', 'description'), image: pick(s, 'image', 'image_url'), html: s.html || '' };
}
function normalizeImage(s) {
  return { type: 'image', filename: String(pick(s, 'filename', 'file', 'name')).split('/').pop(), alt_text: pick(s, 'alt_text', 'alt'), prompt: s.prompt || '', caption: s.caption || '', purpose: s.purpose || '', subject: s.subject || '', generate: !!s.generate };
}
function normalizeSection(s) {
  if (!s || typeof s !== 'object') return null;
  const type = String(s.type || 'paragraph').toLowerCase();
  if (type === 'heading' || type === 'h2' || type === 'h3') return { type: 'heading', level: Math.min(4, Math.max(2, Number(s.level) || (type === 'h3' ? 3 : 2))), content: pick(s, 'content', 'text', 'title') };
  if (type === 'image') return normalizeImage(s);
  if (type === 'ad') return normalizeAd(s);
  if (type === 'checklist') return { type, title: s.title || '', items: Array.isArray(s.items) ? s.items.map(String) : arr(s.items) };
  if (type === 'list' || type === 'bullets') return { type: 'list', ordered: !!s.ordered, items: Array.isArray(s.items) ? s.items.map(String) : arr(s.items) };
  if (type === 'callout' || type === 'tip' || type === 'quote') return { type: 'callout', label: s.label ?? (type === 'quote' ? '' : 'Tip'), content: pick(s, 'content', 'text') };
  return { type: type === 'intro' ? 'intro' : type === 'html' ? 'html' : 'paragraph', content: pick(s, 'content', 'text', 'html') };
}
function normalizePost(raw = {}) {
  let sections = raw.sections;
  if (typeof sections === 'string') { try { sections = JSON.parse(sections); } catch { sections = []; } }
  if (!Array.isArray(sections) || !sections.length) { const c = pick(raw, 'content', 'body', 'article'); if (c) sections = [{ type: 'intro', content: c }]; }
  sections = (sections || []).map(normalizeSection).filter(Boolean);
  let fi = raw.featured_image;
  if (typeof fi === 'string') { try { fi = JSON.parse(fi); } catch { fi = { filename: fi }; } }
  if (!fi && pick(raw, 'featured_image_filename', 'featured_filename')) fi = { filename: pick(raw, 'featured_image_filename', 'featured_filename'), alt_text: pick(raw, 'featured_image_alt', 'featured_alt'), prompt: raw.featured_image_prompt || '', caption: raw.featured_image_caption || '' };
  if (fi && typeof fi === 'object') { fi = normalizeImage(fi); delete fi.type; } else fi = null;
  const title = String(pick(raw, 'title', 'headline')).trim();
  const s = slug(pick(raw, 'slug') || title);
  let postId = String(pick(raw, 'post_id', 'postId')).trim();
  if (!postId || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(postId)) postId = s ? `aura-${s}` : '';
  return {
    post_id: postId, title, slug: s,
    excerpt: pick(raw, 'excerpt', 'description', 'meta_description'),
    primary_keyword: raw.primary_keyword || '', secondary_keywords: arr(raw.secondary_keywords),
    format_variant: raw.format_variant || '',
    categories: arr(pick(raw, 'categories', 'category')), tags: arr(raw.tags),
    status: raw.status || 'draft', date: raw.date || '',
    featured_image: fi && (fi.filename || fi.prompt) ? fi : null, sections
  };
}

// ---------- Mindful Adaption Standard ----------
// Featured image → relatable intro → useful H2 sections → image → ad → practical examples → image → ad → action checklist → closing takeaway
const TAKEAWAY_RE = /takeaway|bottom line|final (thought|word)|closing|conclusion|wrap(ping)?[- ]up|remember this|before you go|the point/i;
const EXAMPLES_RE = /example|in practice|real[- ]?(life|world)|scenario|case|what (this|it) looks like|walk ?through|in action|day in/i;
const DEFAULT_ALT = '{subject|caption|section|title}, illustrating {keyword}';
const GENERIC_CHECKLIST = ['Pick the one idea from this article that fits your life right now', 'Try it for the next 24 hours and notice what changes', 'Block 10 minutes on your calendar this week to review how it went', 'Share one insight with someone you trust', 'Come back to this article in 7 days and adjust your approach'];

function fillTemplate(tpl, ctx) {
  let s = String(tpl || DEFAULT_ALT).replace(/\{([\w|]+)\}/g, (m, ks) => ks.split('|').map(k => ctx[k]).find(v => v && String(v).trim()) || '');
  s = s.replace(/\b(image|photo|picture) of\s+/gi, '').replace(/\s+/g, ' ').replace(/\s([,.;:])/g, '$1').replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, '').trim();
  return clip(s.charAt(0).toUpperCase() + s.slice(1), 125);
}
const genericAlt = (alt, fn) => !alt || alt.trim().length < 8 || /^(image|photo|picture|img|featured|alt)[\s\d_-]*$/i.test(alt.trim()) || lc(alt) === lc(fn);
const defaultPrompt = (p, section, extra) => `Editorial photograph for a blog article titled "${p.title}"${section ? `, supporting the section "${section}"` : ''}. ${extra || ''} Show a real, relatable moment connected to ${p.primary_keyword || p.title}.`.replace(/\s+/g, ' ').trim();

function applyStandard(input, o = {}) {
  const p = structuredClone(input);
  const notes = [], warnings = [];
  const enforce = o.enforce !== false;
  const canGen = !!o.canGenerate;
  const kw = p.primary_keyword || p.title;
  const s = p.sections || [];

  if (enforce && s.length) {
    // 1. Relatable introduction first
    const ft = s.findIndex(x => !['image', 'ad'].includes(x.type));
    if (ft === -1 || s[ft].type !== 'intro') {
      if (ft > -1 && s[ft].type === 'paragraph') s[ft] = { ...s[ft], type: 'intro' };
      else { s.unshift({ type: 'intro', content: p.excerpt || p.title }); notes.push('Added an introduction from the excerpt'); }
    }
    // 2. Featured image
    if (!p.featured_image?.filename) {
      if (canGen) { p.featured_image = { filename: `${p.slug || 'post'}-featured.jpg`, alt_text: '', prompt: p.featured_image?.prompt || defaultPrompt(p, '', 'Wide hero composition.'), caption: '', purpose: 'Featured image', subject: '', generate: true }; notes.push('Added a featured image (will be generated)'); }
      else warnings.push('No featured image and image generation is off');
    }
    // 3. Action checklist
    let ci = s.findIndex(x => x.type === 'checklist');
    const takeIdx = s.findIndex(x => x.type === 'heading' && TAKEAWAY_RE.test(x.content));
    if (ci === -1) {
      const h2 = s.filter(x => x.type === 'heading' && x.level === 2 && !TAKEAWAY_RE.test(x.content) && !EXAMPLES_RE.test(x.content)).map(x => x.content).slice(0, 6);
      const items = h2.length >= 3 ? h2.map(h => `Put "${h.replace(/[.?!:]+$/, '')}" into practice this week`) : GENERIC_CHECKLIST;
      const at = takeIdx > -1 ? takeIdx : s.length;
      s.splice(at, 0, { type: 'checklist', title: 'Your Action Checklist', items });
      notes.push('Added an action checklist (review wording)');
      ci = at;
    }
    // 4. Closing takeaway after the checklist
    const hasTake = s.some((x, i) => i > ci && ((x.type === 'heading' && TAKEAWAY_RE.test(x.content)) || (x.type === 'callout' && TAKEAWAY_RE.test(x.label || ''))));
    if (!hasTake) {
      const intro = s.find(x => x.type === 'intro')?.content || '';
      const closing = p.excerpt || (stripHtml(intro).match(/[^.!?]+[.!?]/g) || []).slice(0, 2).join(' ').trim() || p.title;
      s.push({ type: 'heading', level: 2, content: 'The Takeaway' }, { type: 'paragraph', content: closing });
      notes.push('Added a closing takeaway (review wording)');
    }
    // 5. Image + ad slots in the standard positions
    ci = s.findIndex(x => x.type === 'checklist');
    let slotB = ci;
    if (ci > 0 && s[ci - 1].type === 'heading') slotB = ci - 1;
    const introIdx = s.findIndex(x => x.type === 'intro');
    const bodyH2 = s.map((x, i) => [x, i]).filter(([x, i]) => i > introIdx && i < slotB && x.type === 'heading' && x.level === 2).map(([, i]) => i);
    let slotA = bodyH2.find(i => EXAMPLES_RE.test(s[i].content));
    if (slotA == null) slotA = bodyH2.length >= 2 ? bodyH2[bodyH2.length - 1] : Math.max(introIdx + 1, Math.floor((introIdx + 1 + slotB) / 2));
    if (slotA >= slotB) slotA = Math.max(introIdx + 1, slotB - 1);
    const idxOf = t => s.map((x, i) => x.type === t ? i : -1).filter(i => i > -1);
    const imgs = idxOf('image'), ads = idxOf('ad');
    const has = (list, lo, hi) => list.some(i => i >= lo && i < hi);
    let imgTotal = imgs.length, adTotal = ads.length;
    const insA = [], insB = [];
    const nearHeading = at => { for (let i = at; i >= 0; i--) if (s[i]?.type === 'heading') return s[i].content; return ''; };
    const taken = new Set([p.featured_image?.filename, ...s.filter(x => x.type === 'image').map(x => x.filename)].filter(Boolean).map(lc));
    const newImg = (at, k) => { let f = `${p.slug || 'post'}-inline-${k}.jpg`; while (taken.has(lc(f))) f = `${p.slug || 'post'}-inline-${++k}.jpg`; taken.add(lc(f)); return { type: 'image', filename: f, alt_text: '', caption: '', purpose: 'Supporting image', subject: '', prompt: defaultPrompt(p, nearHeading(at)), generate: true }; };
    if (canGen) {
      if (!has(imgs, slotA, slotB) && imgTotal < 2) { insB.push(newImg(slotB - 1, 2)); imgTotal++; }
      if (!has(imgs, 0, slotA) && imgTotal < 2) { insA.push(newImg(slotA - 1, 1)); imgTotal++; }
    } else if (imgTotal < 2) warnings.push(`Only ${imgTotal} inline image slot(s); the standard expects 2`);
    if (!has(ads, slotA, slotB) && adTotal < 2) { insB.push({ type: 'ad', slot: '' }); adTotal++; }
    if (!has(ads, 0, slotA) && adTotal < 2) { insA.push({ type: 'ad', slot: '' }); adTotal++; }
    if (insB.length) s.splice(slotB, 0, ...insB);
    if (insA.length) s.splice(slotA, 0, ...insA);
    if (insA.length + insB.length) notes.push(`Filled ${insA.length + insB.length} missing image/ad slot(s)`);
  }

  // Unique ad slot names
  const used = new Set(); let n = 0;
  for (const x of s) if (x.type === 'ad') { n++; if (!x.slot || used.has(x.slot)) x.slot = `article-${n}`; while (used.has(x.slot)) x.slot = `article-${++n}`; used.add(x.slot); }

  // Alt text + prompts for every image
  let altFilled = 0, k = 0, lastHeading = '';
  const ctxFor = (img, section, i) => ({ title: p.title, keyword: kw, caption: img.caption, purpose: img.purpose, subject: img.subject, section, n: i });
  if (p.featured_image) {
    if (genericAlt(p.featured_image.alt_text, p.featured_image.filename)) { p.featured_image.alt_text = fillTemplate(o.altTemplate, ctxFor(p.featured_image, '', 0)); altFilled++; }
    if (!p.featured_image.prompt) p.featured_image.prompt = defaultPrompt(p, '', `${p.featured_image.caption || p.featured_image.alt_text}. Wide hero composition.`);
  }
  for (const x of s) {
    if (x.type === 'heading') lastHeading = x.content;
    if (x.type !== 'image') continue;
    k++;
    if (!x.filename) x.filename = `${p.slug || 'post'}-inline-${k}.jpg`;
    if (genericAlt(x.alt_text, x.filename)) { x.alt_text = fillTemplate(o.altTemplate, ctxFor(x, lastHeading, k)); altFilled++; }
    if (!x.prompt) x.prompt = defaultPrompt(p, lastHeading, x.caption || x.alt_text);
  }
  if (altFilled) notes.push(`Wrote alt text for ${altFilled} image(s) from the template`);

  // Stats
  const words = s.reduce((t, x) => t + countWords([x.content, x.label, ...(x.items || [])].filter(Boolean).join(' ')), 0);
  const minutes = Math.max(1, Math.round(words / 230));
  const h2 = s.filter(x => x.type === 'heading' && x.level === 2).length;
  if (enforce) {
    if (h2 < 3) warnings.push(`Only ${h2} H2 section(s); the standard expects at least 3 useful sections`);
    if (words < 1300) warnings.push(`About ${minutes} min read (${words} words), under the 7-minute target`);
    if (words > 2200) warnings.push(`About ${minutes} min read (${words} words), over the 7-minute target`);
  }
  p.sections = s;
  p.standard = { name: 'Mindful Adaption Standard', applied: enforce, notes, warnings, stats: { words, minutes, h2, images: s.filter(x => x.type === 'image').length + (p.featured_image ? 1 : 0), ads: s.filter(x => x.type === 'ad').length } };
  return p;
}

function imageList(p) {
  const out = [];
  if (p.featured_image?.filename) out.push({ ...p.featured_image, featured: true });
  for (const x of p.sections || []) if (x.type === 'image' && x.filename) out.push(x);
  return out;
}

function validate(p, assetNames = [], o = {}) {
  const errors = [], warnings = [...(p.standard?.warnings || [])];
  if (!p.post_id) errors.push('Missing post_id');
  if (!p.title) errors.push('Missing title');
  if (!p.sections?.length) errors.push('Missing sections');
  if ((p.sections || []).some(s => s.type === 'image' && !s.filename)) errors.push('Image section missing filename');
  const have = new Set(assetNames.map(lc));
  const pendingImages = [];
  for (const img of imageList(p)) {
    if (have.has(lc(img.filename))) continue;
    if (o.canGenerate) pendingImages.push(img.filename);
    else errors.push(`Missing image: ${img.filename} (add it to the ZIP or turn on image generation)`);
  }
  return { ok: errors.length === 0, errors, warnings, pendingImages, requiredImages: imageList(p).filter(i => !i.featured).map(i => i.filename), featured: p.featured_image?.filename || null };
}

// ---------- import ----------
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const h = (rows.shift() || []).map(x => x.trim().replace(/^\uFEFF/, ''));
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

async function importEntries(entries) {
  const assetMap = new Map(), jsonEntries = [], csvEntries = [], looseEntries = [];
  for (const e of entries) {
    const n = e.name.toLowerCase(), base = e.name.split('/').pop();
    if (base.startsWith('._')) continue;
    if (/\.(png|jpe?g|webp|gif)$/i.test(n)) { assetMap.set(lc(base), { name: base, mime: mimeFor(n), buffer: e.buffer }); continue; }
    if (n.endsWith('.json')) { jsonEntries.push(e); continue; }
    if (n.endsWith('.csv')) { csvEntries.push(e); continue; }
    looseEntries.push(e);
  }
  let rawPosts = [], manifestSource = '';
  const preferredJson = jsonEntries.find(e => /(^|\/)aura-posts\.json$/i.test(e.name)) || jsonEntries.find(e => /(^|\/)(posts|articles|manifest)\.json$/i.test(e.name));
  const usableJson = [];
  for (const e of jsonEntries) {
    try {
      const j = JSON.parse(e.buffer.toString('utf8').replace(/^\uFEFF/, ''));
      const candidates = Array.isArray(j) ? j : (Array.isArray(j?.posts) ? j.posts : (j && typeof j === 'object' && (j.title || j.sections) ? [j] : []));
      if (candidates.length && candidates.some(x => x && typeof x === 'object' && (x.post_id || x.title || x.sections))) usableJson.push({ e, j, candidates });
    } catch (err) { if (e === preferredJson) throw new Error(`Invalid JSON in ${e.name}: ${err.message}`); }
  }
  const chosen = (preferredJson && usableJson.find(x => x.e === preferredJson)) || usableJson.find(x => Array.isArray(x.j?.posts)) || usableJson[0] || null;
  if (chosen) { rawPosts = chosen.candidates; manifestSource = chosen.e.name; }
  else if (csvEntries.length) {
    const c = csvEntries.find(e => /(^|\/)aura-posts\.csv$/i.test(e.name)) || csvEntries[0];
    rawPosts = parseCSV(c.buffer.toString('utf8')).map(row => {
      if (!row.sections && row.sections_json) { try { row.sections = JSON.parse(row.sections_json); } catch (err) { row._sections_parse_error = `Invalid sections_json: ${err.message}`; } }
      return row;
    });
    manifestSource = c.name;
  } else {
    for (const e of looseEntries) {
      const n = e.name.toLowerCase(), b = e.buffer;
      if (n.endsWith('.md') || n.endsWith('.txt') || n.endsWith('.html')) {
        const t = b.toString('utf8'), title = t.split(/\r?\n/).find(Boolean)?.replace(/^#+\s*/, '').replace(/<[^>]+>/g, '') || e.name;
        rawPosts.push({ post_id: e.name.replace(/\..+$/, ''), title, sections: n.endsWith('.html') ? [{ type: 'html', content: t }] : t.split(/\r?\n\s*\r?\n/).filter(Boolean).slice(1).map(block => /^#{2,3}\s/.test(block) ? { type: 'heading', level: block.startsWith('###') ? 3 : 2, content: block.replace(/^#+\s*/, '') } : { type: 'paragraph', content: block.trim() }) });
      } else if (n.endsWith('.docx')) {
        const { default: mammoth } = await import('mammoth');
        const x = await mammoth.convertToHtml({ buffer: b });
        rawPosts.push({ post_id: e.name.replace(/\.docx$/i, ''), title: e.name.replace(/\.docx$/i, ''), sections: [{ type: 'html', content: x.value }] });
      } else if (n.endsWith('.pdf')) {
        // Import the library file directly: pdf-parse's index runs a debug self-test under ESM and can crash.
        const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
        const x = await pdf(b);
        rawPosts.push({ post_id: e.name.replace(/\.pdf$/i, ''), title: x.text.split(/\r?\n/).find(Boolean) || e.name, sections: x.text.split(/\n\s*\n/).filter(Boolean).map(t => ({ type: 'paragraph', content: t.trim() })) });
      }
    }
    manifestSource = looseEntries.length ? 'loose documents' : '';
  }
  return { rawPosts, manifestSource, assetMap };
}

function preparePosts(rawPosts, assetNames, options) {
  const seen = new Set();
  return rawPosts.map(raw => {
    const base = normalizePost(raw);
    const p = applyStandard(base, options);
    p.source = base; // kept so the standard can be re-applied cleanly when settings change
    p.validation = validate(p, assetNames, options);
    if (raw?._sections_parse_error) { p.validation.ok = false; p.validation.errors.push(raw._sections_parse_error); }
    if (p.post_id && seen.has(p.post_id)) { p.validation.ok = false; p.validation.errors.push(`Duplicate post_id inside manifest: ${p.post_id}`); }
    if (p.post_id) seen.add(p.post_id);
    return p;
  });
}
const readJson = v => { try { return typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); } catch { return {}; } };

// ---------- rendering (Gutenberg blocks) ----------
function inline(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, a, u) => `<a href="${u}">${a}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return t;
}
const block = (name, html, attrs) => `<!-- wp:${name}${attrs ? ' ' + JSON.stringify(attrs) : ''} -->\n${html}\n<!-- /wp:${name} -->`;

function resolveAd(sec, adIndex, p, o) {
  const lib = (o.ads || []).filter(a => a && a.enabled !== false && (a.url || a.html));
  const fromLib = lib.find(a => a.slot && a.slot === sec.slot) || (lib.length ? lib[(hash(p.slug || p.title) + adIndex) % lib.length] : null);
  if (sec.html) return { html: sec.html };
  if (sec.url) return { ...(fromLib || {}), ...Object.fromEntries(Object.entries(sec).filter(([, v]) => v)), html: '' };
  return fromLib;
}
function renderAd(ad, sec, o) {
  if (!ad) return block('html', `<!-- AURA:AD:${esc(sec.slot)} --><div class="aura-ad-slot" data-slot="${esc(sec.slot)}"></div>`);
  if (ad.html) return block('html', `<div class="aura-ad aura-ad-code" data-slot="${esc(sec.slot)}">${ad.html}</div>`);
  const url = esc(ad.url), label = esc(o.adLabel || 'Sponsored');
  const img = ad.image ? `<a href="${url}" target="_blank" rel="sponsored noopener"><img src="${esc(ad.image)}" alt="${esc(ad.label || 'Sponsored offer')}" style="width:100%;height:auto;border-radius:10px;margin:0 0 12px" loading="lazy"></a>` : '';
  return block('html', `<aside class="aura-ad" data-slot="${esc(sec.slot)}" style="margin:2em 0;padding:18px 20px;border:1px solid #dfe6ef;border-radius:14px;background:#f7f9fc">
<p style="margin:0 0 8px;font-size:12px;letter-spacing:.06em;color:#667085">${label}</p>${img}
<p style="margin:0 0 8px;font-size:1.15em;font-weight:700"><a href="${url}" target="_blank" rel="sponsored noopener">${esc(ad.label || 'Recommended resource')}</a></p>
${ad.text ? `<p style="margin:0 0 14px">${esc(ad.text)}</p>` : ''}<p style="margin:0"><a href="${url}" target="_blank" rel="sponsored noopener" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#0d64bc;color:#fff;text-decoration:none;font-weight:600">${esc(ad.cta || 'Learn more')}</a></p>
</aside>`);
}
function renderPost(p, media, o = {}) {
  let adIndex = 0;
  return p.sections.map((s, i) => {
    const prev = p.sections[i - 1];
    switch (s.type) {
      case 'heading': return s.level === 2 ? block('heading', `<h2 class="wp-block-heading">${inline(s.content)}</h2>`) : block('heading', `<h${s.level} class="wp-block-heading">${inline(s.content)}</h${s.level}>`, { level: s.level });
      case 'intro': return block('paragraph', `<p class="aura-intro">${inline(s.content)}</p>`, { className: 'aura-intro' });
      case 'image': {
        const m = media[lc(s.filename)];
        if (!m) return `<!-- AURA:MISSING:${esc(s.filename)} -->`;
        const cap = s.caption ? `<figcaption class="wp-element-caption">${esc(s.caption)}</figcaption>` : '';
        return block('image', `<figure class="wp-block-image size-large"><img src="${esc(m.source_url)}" alt="${esc(s.alt_text)}" class="wp-image-${m.id}"/>${cap}</figure>`, { id: m.id, sizeSlug: 'large', linkDestination: 'none' });
      }
      case 'ad': return renderAd(resolveAd(s, adIndex++, p, o), s, o);
      case 'list': { const tag = s.ordered ? 'ol' : 'ul'; return block('list', `<${tag} class="wp-block-list">${s.items.map(x => `<!-- wp:list-item -->\n<li>${inline(x)}</li>\n<!-- /wp:list-item -->`).join('\n')}</${tag}>`, s.ordered ? { ordered: true } : null); }
      case 'checklist': {
        const title = s.title && prev?.type !== 'heading' ? block('heading', `<h2 class="wp-block-heading">${inline(s.title)}</h2>`) + '\n\n' : '';
        return title + block('html', `<ul class="aura-checklist" style="list-style:none;padding-left:0">${s.items.map(x => `<li style="margin:.55em 0;padding-left:1.8em;position:relative"><span aria-hidden="true" style="position:absolute;left:0">☐</span>${inline(x)}</li>`).join('')}</ul>`);
      }
      case 'callout': return block('html', `<aside class="aura-callout" style="margin:1.6em 0;padding:16px 20px;border-left:4px solid #0d64bc;background:#f2f7fd;border-radius:8px">${s.label ? `<p style="margin:0 0 6px;font-weight:700">${esc(s.label)}</p>` : ''}<p style="margin:0">${inline(s.content)}</p></aside>`);
      case 'html': return block('html', s.content);
      default: return block('paragraph', `<p>${inline(s.content)}</p>`);
    }
  }).join('\n\n');
}

// ---------- terms & media ----------
async function termId(w, type, name, cache) {
  name = String(name || '').trim(); if (!name) return null;
  const key = `${type}:${name.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const list = await wpFetch(w, `${type}?search=${encodeURIComponent(name)}&per_page=100&_fields=id,name,slug`);
  const hit = (Array.isArray(list) ? list : []).find(x => decodeEntities(x.name).toLowerCase() === name.toLowerCase() || x.slug === slug(name));
  let id = hit?.id;
  if (!id) {
    try { id = (await wpFetch(w, type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).id; }
    catch (e) { if (e.wpCode === 'term_exists' && e.data?.term_id) id = e.data.term_id; else throw e; }
  }
  cache.set(key, id);
  return id;
}
async function setMediaMeta(w, id, meta) {
  const patch = {};
  if (meta.alt) patch.alt_text = meta.alt;
  if (meta.caption) patch.caption = meta.caption;
  if (meta.title) patch.title = meta.title;
  if (Object.keys(patch).length) await wpFetch(w, `media/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
}
async function uploadMedia(w, file, meta) {
  const name = asciiName(file.originalname);
  const r = await wpFetch(w, 'media', { method: 'POST', timeout: 120000, headers: { 'Content-Type': mimeFor(name), 'Content-Disposition': `attachment; filename="${name}"` }, body: file.buffer });
  await setMediaMeta(w, r.id, meta);
  return { id: r.id, source_url: r.source_url };
}

// ---------- routes ----------
const healthBody = () => ({ ok: true, status: 'online', service: 'Aura Publisher Pro API', version: API_VERSION, protocol: PROTOCOL, features: { imageGeneration: !!process.env.OPENAI_API_KEY, imageModel: IMAGE_MODEL, standard: 'Mindful Adaption Standard', statuses: ['draft', 'publish', 'future', 'pending', 'private'] } });
app.get('/', (q, r) => r.type('html').send(`<h1>Aura Publisher Pro API</h1><p>Online — V11 (API ${API_VERSION})</p>`));
app.get('/healthz', (q, r) => r.json(healthBody()));
app.get('/health', (q, r) => r.json(healthBody()));

app.post('/api/wp/test', async (req, res) => {
  try {
    const w = req.body.wordpress || {};
    if (!w.username || !w.appPassword) return res.status(400).json({ error: 'Enter your WordPress username and Application Password.' });
    const d = await discoverWp(w), creds = { ...w, url: d.site, restRoot: d.root };
    const me = await wpFetch(creds, 'users/me?context=edit');
    const caps = me.capabilities || {};
    res.json({ ok: true, site: d.site, restRoot: d.root, user: { id: me.id, name: me.name, slug: me.slug, roles: me.roles || [] },
      canPublish: !!caps.publish_posts, canUpload: !!caps.upload_files, unfilteredHtml: !!caps.unfiltered_html });
  } catch (e) { res.status(400).json(wpError(e)); }
});

app.post('/api/import', upload.array('files', 200), async (req, res) => {
  try {
    const options = readJson(req.body.options);
    const entries = [];
    for (const f of req.files || []) {
      if (f.originalname.toLowerCase().endsWith('.zip')) {
        const z = new AdmZip(f.buffer);
        for (const e of z.getEntries()) if (!e.isDirectory && !e.entryName.startsWith('__MACOSX/')) entries.push({ name: e.entryName, buffer: e.getData() });
      } else entries.push({ name: f.originalname, buffer: f.buffer });
    }
    if (!entries.length) return res.status(400).json({ error: 'Choose at least one file or ZIP package.' });
    const { rawPosts, manifestSource, assetMap } = await importEntries(entries);
    const extra = Array.isArray(options.existingAssets) ? options.existingAssets : [];
    const names = [...assetMap.values()].map(a => a.name);
    const posts = preparePosts(rawPosts, [...names, ...extra], options);
    res.json({
      protocolVersion: PROTOCOL, manifestSource, posts,
      assets: [...assetMap.values()].map(a => ({ name: a.name, mime: a.mime, size: a.buffer.length, dataBase64: a.buffer.toString('base64') })),
      summary: { posts: posts.length, assets: names.length, ready: posts.filter(p => p.validation.ok).length, invalid: posts.filter(p => !p.validation.ok).length, pendingImages: posts.reduce((t, p) => t + p.validation.pendingImages.length, 0) }
    });
  } catch (e) { res.status(400).json({ error: `Import failed: ${e.message}` }); }
});

// Re-apply the standard after settings change (no files involved).
app.post('/api/standardize', (req, res) => {
  try {
    const { posts = [], options = {}, assetNames = [] } = req.body || {};
    const out = posts.slice(0, 500).map(p => {
      const base = normalizePost(p.source || p);
      const s = applyStandard(base, options);
      s.source = base;
      s.validation = validate(s, assetNames, options);
      return { ...s, wp: p.wp, target: p.target };
    });
    res.json({ ok: true, posts: out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/images/generate', imageLimiter, async (req, res) => {
  const { prompt, filename, style, quality, openaiKey } = req.body || {};
  const key = String(openaiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!key) return res.status(400).json({ error: 'Image generation is not configured. Add OPENAI_API_KEY on Render, or your own OpenAI key in Connections.', code: 'no_image_key' });
  if (!prompt) return res.status(400).json({ error: 'Image prompt is empty.' });
  const name = asciiName(filename || 'aura-image.jpg');
  const ext = name.toLowerCase().split('.').pop();
  const format = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpeg';
  const fullPrompt = `${prompt}\n\nVisual style: ${style || 'Photorealistic editorial photography, natural light, authentic real people and settings, shallow depth of field, warm and hopeful mood.'}\nStrict rules: no text, no letters, no captions, no watermarks, no logos, no brand names, no UI screenshots.`.slice(0, 30000);
  const dalle = /^dall-e/i.test(IMAGE_MODEL);
  const body = dalle
    ? { model: IMAGE_MODEL, prompt: fullPrompt.slice(0, 3900), n: 1, size: '1792x1024', response_format: 'b64_json' }
    : { model: IMAGE_MODEL, prompt: fullPrompt, n: 1, size: '1536x1024', quality: ['low', 'medium', 'high', 'auto'].includes(quality) ? quality : 'medium', output_format: format, ...(format !== 'png' ? { output_compression: 85 } : {}) };
  for (let attempt = 0; attempt < 4; attempt++) {
    let r, j;
    try {
      r = await fetchTimed(`${OPENAI_BASE}/images/generations`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 240000);
      j = await parseBody(r);
    } catch (e) {
      if (attempt < 3) { await sleep(3000 * (attempt + 1)); continue; }
      return res.status(504).json({ error: `Image generation timed out: ${e.message}` });
    }
    if (r.ok) {
      const b64 = j.data?.[0]?.b64_json;
      if (!b64) return res.status(502).json({ error: 'OpenAI returned no image data.' });
      return res.json({ ok: true, name, mime: dalle ? 'image/png' : mimeFor(name), dataBase64: b64, model: IMAGE_MODEL });
    }
    const code = j.error?.code || j.error?.type;
    const retryable = (r.status === 429 && !['insufficient_quota', 'billing_hard_limit_reached'].includes(code)) || r.status >= 500;
    if (!retryable || attempt === 3) return res.status(r.status === 429 ? 429 : 400).json({ error: `OpenAI: ${j.error?.message || `request failed (${r.status})`}`, code });
    const ra = Number(r.headers.get('retry-after')) || 0;
    await sleep(Math.min(60000, ra ? ra * 1000 : 5000 * 2 ** attempt));
  }
});

app.post('/api/publish', upload.array('assets', 200), async (req, res) => {
  try {
    const w = readJson(req.body.wordpress), o = readJson(req.body.options), raw = readJson(req.body.post);
    if (!w.url || !w.username || !w.appPassword) return res.status(400).json({ error: 'WordPress connection is incomplete. Add your site, username and Application Password in Connections.' });
    const p = normalizePost(raw); // sections arrive already standard-enforced from the queue
    const files = Object.fromEntries((req.files || []).map(f => [lc(f.originalname), f]));
    const existing = Object.fromEntries(Object.entries(o.existingMedia || {}).map(([k, v]) => [lc(k), v]));
    const v = validate(p, [...Object.keys(files), ...Object.keys(existing)], { canGenerate: false });
    if (!v.ok) return res.status(422).json({ error: 'Post is not publish-ready.', ...v });

    const status = ['draft', 'publish', 'future', 'pending', 'private'].includes(o.status) ? o.status : (p.status || 'draft');
    const date = o.date || (status === 'future' ? p.date : '') || '';
    if (status === 'future' && !date) return res.status(422).json({ error: 'Pick a date and time to schedule this post.' });

    const d = await discoverWp(w), creds = { ...w, url: d.site, restRoot: d.root };
    if (['publish', 'future', 'private'].includes(status)) {
      const me = await wpFetch(creds, 'users/me?context=edit&_fields=id,capabilities');
      if (me.capabilities && !me.capabilities.publish_posts) return res.status(403).json({ error: 'This WordPress user can only save drafts (the role lacks publish_posts). Use an Author/Editor/Administrator account, or choose "Pending review".', code: 'cannot_publish' });
    }

    // Media: reuse verified uploads from earlier publishes, upload the rest.
    const media = {}; let uploaded = 0, reused = 0;
    for (const img of imageList(p)) {
      const k = lc(img.filename);
      if (media[k]) continue;
      const meta = { alt: img.alt_text, caption: img.caption, title: clip(img.alt_text || p.title, 90) };
      if (existing[k]?.id && !files[k]) {
        try { const m = await wpFetch(creds, `media/${existing[k].id}?_fields=id,source_url`); media[k] = { id: m.id, source_url: m.source_url }; reused++; continue; } catch {}
      }
      const f = files[k];
      if (!f) return res.status(422).json({ error: `Image missing from this device: ${img.filename}. Generate or re-import it, then publish again.` });
      media[k] = await uploadMedia(creds, f, meta); uploaded++;
    }

    const cache = new Map(), cats = [], tags = [];
    for (const x of p.categories) { const id = await termId(creds, 'categories', x, cache); if (id) cats.push(id); }
    for (const x of p.tags) { const id = await termId(creds, 'tags', x, cache); if (id) tags.push(id); }
    const featured = p.featured_image?.filename ? media[lc(p.featured_image.filename)]?.id || 0 : 0;
    const body = { title: p.title, slug: p.slug, excerpt: p.excerpt, content: renderPost(p, media, o), status, categories: cats, tags, featured_media: featured };
    if (date) body.date = date;

    // Upsert: update the same WordPress post instead of creating duplicates.
    let target = null;
    if (o.mode !== 'new') {
      if (o.wpPostId) { try { target = (await wpFetch(creds, `posts/${o.wpPostId}?context=edit&_fields=id`)).id; } catch {} }
      if (!target && p.slug) {
        const found = await wpFetch(creds, `posts?slug=${encodeURIComponent(p.slug)}&status=publish,future,draft,pending,private&context=edit&_fields=id`);
        if (Array.isArray(found) && found[0]) target = found[0].id;
      }
    }
    const out = await wpFetch(creds, target ? `posts/${target}` : 'posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    res.json({ ok: true, id: out.id, link: out.link, status: out.status, updated: !!target, uploadedImages: uploaded, reusedImages: reused,
      media: Object.fromEntries(imageList(p).map(i => [i.filename, media[lc(i.filename)]]).filter(([, m]) => m)) });
  } catch (e) { const o = wpError(e); res.status(o.status === 401 ? 401 : 400).json(o); }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.path }));
app.use((e, q, r, n) => r.status(e.status === 413 || e.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: e.message }));

export { normalizePost, applyStandard, validate, renderPost };
if (process.env.AURA_NO_LISTEN !== '1') app.listen(PORT, '0.0.0.0', () => console.log(`Aura V11 (API ${API_VERSION}) listening on ${PORT}`));
