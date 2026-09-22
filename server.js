// Aura Publisher Pro — API 6.0.0 (V13)
// Mindful Adaption Standard enforcement, real publishing (publish / schedule / pending / draft),
// idempotent upserts, ad-slot filling, alt-text templating, AI image generation, WP retry/backoff.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import AdmZip from 'adm-zip';

const API_VERSION = '7.0.0';
const PROTOCOL = 'aura-16';
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


function routeUrlNs(root, namespace, path = '') {
  const ns = String(namespace || '').replace(/^\/+|\/+$/g, '');
  const p = String(path || '').replace(/^\//, '');
  if (root.includes('rest_route=')) return `${root}${ns}/${p}`;
  return `${root}${ns}/${p}`;
}

async function wpFetchNs(w, namespace, path, opts = {}) {
  const d = w.restRoot ? { root: w.restRoot } : await discoverWp(w);
  const url = routeUrlNs(d.root, namespace, path);
  let r;
  try {
    r = await fetchTimed(url, { ...opts, headers: { Accept: 'application/json', Authorization: authHeader(w), ...(opts.headers || {}) } }, opts.timeout || 60000);
  } catch (e) {
    throw Object.assign(new Error(`Could not reach WordPress (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`), { code: 'wp_network', url });
  }
  const j = await parseBody(r);
  if (!r.ok) throw Object.assign(new Error(j.message || `WordPress returned ${r.status}`), { status: r.status, wpCode: j.code, data: j.data, url });
  return j;
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
  return { type: 'ad', slot: String(s.slot || ''), ad_id: String(pick(s, 'ad_id', 'affiliate_id', 'id') || ''), placement: ['side', 'inline'].includes(String(s.placement).toLowerCase()) ? String(s.placement).toLowerCase() : 'inline', label: pick(s, 'label', 'headline', 'title'), url: pick(s, 'url', 'link', 'href'), cta: pick(s, 'cta', 'button'), text: pick(s, 'text', 'content', 'description'), image: pick(s, 'image', 'image_url'), html: s.html || '' };
}
function normalizeImage(s) {
  return { type: 'image', filename: String(pick(s, 'filename', 'file', 'name')).split('/').pop(), alt_text: pick(s, 'alt_text', 'alt'), prompt: s.prompt || '', caption: s.caption || '', purpose: s.purpose || '', subject: s.subject || '', concept: s.concept || '', shot: s.shot || '', setting: s.setting || '', time_of_day: s.time_of_day || '', lighting: s.lighting || '', lens: s.lens || '', palette: s.palette || '', people: s.people || '', emotion: s.emotion || '', generic_prompt: !!s.generic_prompt, generate: !!s.generate };
}
function normalizeSection(s) {
  if (!s || typeof s !== 'object') return null;
  const type = String(s.type || 'paragraph').toLowerCase();
  if (type === 'heading' || type === 'h2' || type === 'h3') return { type: 'heading', level: Math.min(4, Math.max(2, Number(s.level) || (type === 'h3' ? 3 : 2))), content: pick(s, 'content', 'text', 'title') };
  if (type === 'image') return normalizeImage(s);
  if (type === 'ad') return normalizeAd(s);
  if (type === 'checklist') return { type, title: s.title || '', items: Array.isArray(s.items) ? s.items.map(String) : arr(s.items) };
  if (type === 'list' || type === 'bullets') return { type: 'list', ordered: !!s.ordered, items: Array.isArray(s.items) ? s.items.map(String) : arr(s.items) };
  if (type === 'callout' || type === 'tip' || type === 'note' || type === 'warning' || type === 'example') return { type: 'callout', tone: ['tip', 'note', 'warning', 'example'].includes(String(s.tone || type).toLowerCase()) ? String(s.tone || type).toLowerCase() : 'tip', label: s.label ?? ({ note: 'Good to know', warning: 'Watch out', example: 'Example' }[type] || 'Try this'), content: pick(s, 'content', 'text') };
  if (type === 'quote' || type === 'pullquote') return { type: 'pullquote', content: pick(s, 'content', 'text', 'quote'), cite: s.cite || s.attribution || '' };
  if (type === 'takeaways' || type === 'key_takeaways' || type === 'summary') return { type: 'takeaways', title: s.title || 'Key takeaways', items: (Array.isArray(s.items) ? s.items.map(String) : arr(s.items)).filter(Boolean).slice(0, 6) };
  if (type === 'faq' || type === 'faqs') {
    const items = (Array.isArray(s.items) ? s.items : []).map(q => ({ q: String(pick(q, 'q', 'question')).trim(), a: String(pick(q, 'a', 'answer')).trim() })).filter(q => q.q && q.a).slice(0, 8);
    return items.length ? { type: 'faq', title: s.title || 'Frequently asked questions', items } : null;
  }
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
    meta_title: String(pick(raw, 'meta_title', 'seo_title')).trim(), meta_description: String(pick(raw, 'meta_description', 'seo_description')).trim(),
    focus_keyphrase: String(pick(raw, 'focus_keyphrase', 'focus_keyword')).trim(),
    primary_keyword: raw.primary_keyword || '', secondary_keywords: arr(raw.secondary_keywords),
    format_variant: raw.format_variant || '', hero_text: clip(raw.hero_text || '', 70), hero_tagline: String(raw.hero_tagline || '').trim(), cover_notes: arr(raw.cover_notes).slice(0, 3),
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

  // SEO fields: clean excerpt / meta description / meta title that never end mid-word
  const sentenceClip = (t, max) => {
    t = stripHtml(String(t || '')).replace(/\*\*|\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max + 1), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (end > max * 0.6) return cut.slice(0, end + 1);
    return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:—–-]+$/, '') + '…';
  };
  const cutOff = t => t && t.length >= 120 && !/[.!?…"')]$/.test(t.trim());
  const introText = s.find(x => x.type === 'intro')?.content || '';
  if (!p.meta_description || cutOff(p.meta_description) || p.meta_description.length > 165) { const before = p.meta_description; p.meta_description = sentenceClip(p.meta_description && !cutOff(p.meta_description) ? p.meta_description : (p.excerpt && !cutOff(p.excerpt) ? p.excerpt : introText), 158); if (before !== p.meta_description) notes.push('Wrote a clean meta description'); }
  if (!p.excerpt || cutOff(p.excerpt) || p.excerpt.length > 300) { p.excerpt = p.meta_description; notes.push('Fixed a cut-off excerpt'); }
  if (!p.meta_title) p.meta_title = clip(p.title, 60);
  if (!p.focus_keyphrase) p.focus_keyphrase = p.primary_keyword || '';
  if (!p.primary_keyword && p.focus_keyphrase) p.primary_keyword = p.focus_keyphrase;
  if (!p.tags.length) { p.tags = [...new Set([p.primary_keyword, ...(p.secondary_keywords || [])].filter(Boolean).map(t => t.replace(/\b\w/g, c => c.toUpperCase())))].slice(0, 6); if (p.tags.length) notes.push('Created tags from the keywords'); }
  if (!p.slug) p.slug = slug(p.primary_keyword && !slug(p.title).includes(slug(p.primary_keyword)) ? `${p.primary_keyword} ${p.title}` : p.title).split('-').slice(0, 8).join('-');
  // Key takeaways box right after the intro (built from the H2s when ChatGPT did not supply one)
  if (enforce && !s.some(x => x.type === 'takeaways')) {
    const h2s = s.filter(x => x.type === 'heading' && x.level === 2 && !TAKEAWAY_RE.test(x.content) && !/checklist|faq|frequently asked/i.test(x.content)).map(x => x.content.replace(/^(step \d+:\s*)/i, '').replace(/[.?!:]+$/, ''));
    const at = s.findIndex(x => x.type === 'intro');
    if (h2s.length >= 3 && at > -1) { s.splice(at + 1, 0, { type: 'takeaways', title: "What you'll learn", items: h2s.slice(0, 5) }); notes.push('Added a "What you\'ll learn" box from the section headings'); }
  }

  // Unique ad slot names
  const used = new Set(); let n = 0;
  for (const x of s) if (x.type === 'ad') { n++; if (!x.slot || used.has(x.slot)) x.slot = `article-${n}`; while (used.has(x.slot)) x.slot = `article-${++n}`; used.add(x.slot); }

  // Image names + art direction first, then alt text/captions built from what each photo really shows
  let k = 0;
  for (const x of s) if (x.type === 'image') { k++; if (!x.filename) x.filename = `${p.slug || 'post'}-inline-${k}.jpg`; }
  p.sections = s;
  const imgs = [p.featured_image, ...s.filter(x => x.type === 'image')].filter(Boolean);
  const altSeen = new Map(), capSeen = new Map();
  for (const x of imgs) { altSeen.set(lc(x.alt_text), (altSeen.get(lc(x.alt_text)) || 0) + 1); capSeen.set(lc(x.caption), (capSeen.get(lc(x.caption)) || 0) + 1); }
  const haveSet = new Set((o.assetNames || []).map(lc)), haveAsset = img => haveSet.has(lc(img.filename));
  const dupAlts = o.dupAlts instanceof Set ? o.dupAlts : new Set(), dupCaps = o.dupCaps instanceof Set ? o.dupCaps : new Set();
  if ([p.featured_image, ...s].some(x => x?.generic_prompt)) notes.push('Replaced templated image prompts with photo direction written for each section');
  artDirect(p, o); // photoreal, people-first, section-matched, unique direction for every image
  let altFilled = 0, capFixed = 0, lastHeading = '';
  const truncated = a => a && a.length >= 118 && !/[.!?)"']$/.test(a.trim()) && /\s\w{1,4}$/.test(a.trim()) && !/\s(and|or|of|in|on|at|a|an|the)$/.test(a);
  const fix = (img, section, n) => {
    const a = String(img.alt_text || '');
    if (genericAlt(a, img.filename) || altSeen.get(lc(a)) > 1 || dupAlts.has(lc(a)) || truncated(a)) {
      img.alt_text = fillTemplate(o.altTemplate, { title: p.title, keyword: kw, caption: '', purpose: img.purpose, subject: haveAsset(img) ? img.subject : (img.art_alt || img.subject), section, n }); altFilled++;
    }
    if (img.caption && (capSeen.get(lc(img.caption)) > 1 || dupCaps.has(lc(img.caption)))) { img.caption = ''; capFixed++; }
    if (!img.prompt) img.prompt = defaultPrompt(p, section, img.alt_text);
  };
  if (p.featured_image) { fix(p.featured_image, '', 0); const kwx = p.primary_keyword || p.focus_keyphrase; if (kwx && !p.featured_image.alt_text.toLowerCase().includes(kwx.toLowerCase())) p.featured_image.alt_text = clip(`${cap1(kwx)}: ${p.featured_image.alt_text.replace(/, illustrating .*$/, '')}`, 125); }
  k = 0;
  for (const x of s) { if (x.type === 'heading') lastHeading = x.content; if (x.type === 'image') fix(x, lastHeading, ++k); }
  if (altFilled) notes.push(`Rewrote ${altFilled} generic, repeated or cut-off alt text${altFilled > 1 ? 's' : ''} to describe each photo`);
  if (capFixed) notes.push(`Removed ${capFixed} repeated caption${capFixed > 1 ? 's' : ''}`);

  // Stats
  const words = s.reduce((t, x) => t + (x.type === 'takeaways' ? 0 : countWords([x.content, x.label, x.cite, ...(x.items || []).map(it => typeof it === 'object' ? `${it.q} ${it.a}` : it)].filter(Boolean).join(' '))), 0);
  const minutes = Math.max(1, Math.round(words / 230));
  const h2 = s.filter(x => x.type === 'heading' && x.level === 2).length;
  if (enforce) {
    if (h2 < 3) warnings.push(`Only ${h2} H2 section(s); the standard expects at least 3 useful sections`);
    if (words < 1300) warnings.push(`About ${minutes} min read (${words} words), under the 7-minute target`);
    if (words > 2200) warnings.push(`About ${minutes} min read (${words} words), over the 7-minute target`);
  }
  p.sections = s;
  p.seo = seoAudit(p, words);
  p.standard = { name: 'Mindful Adaption Standard', applied: enforce, notes, warnings, stats: { words, minutes, h2, images: s.filter(x => x.type === 'image').length + (p.featured_image ? 1 : 0), ads: s.filter(x => x.type === 'ad').length } };
  return p;
}

// Yoast-style checks so every post leaves Aura with its SEO basics done.
function seoAudit(p, words) {
  const kw = String(p.focus_keyphrase || p.primary_keyword || '').toLowerCase().trim();
  const has = t => kw && String(t || '').toLowerCase().includes(kw);
  const sec = p.sections || [];
  const intro = sec.find(x => x.type === 'intro')?.content || '';
  const first100 = [intro, ...sec.filter(x => x.type === 'paragraph').map(x => x.content)].join(' ').split(/\s+/).slice(0, 100).join(' ');
  const h2 = sec.filter(x => x.type === 'heading');
  const imgs = [p.featured_image, ...sec.filter(x => x.type === 'image')].filter(Boolean);
  const text = sec.map(x => x.content || '').join(' ');
  const links = (text.match(/\]\((https?:|aff:)/g) || []).length;
  const kwCount = kw ? (text.toLowerCase().split(kw).length - 1) : 0;
  const density = words ? kwCount * kw.split(/\s+/).length / words * 100 : 0;
  const checks = [
    ['Focus keyphrase set', !!kw],
    ['Keyphrase in title', has(p.title)],
    ['Title length 40–65 characters', p.title.length >= 40 && p.title.length <= 65],
    ['Keyphrase in slug', kw && p.slug.includes(slug(kw))],
    ['Meta title up to 60 characters', !!p.meta_title && p.meta_title.length <= 60],
    ['Meta description 120–160 characters', !!p.meta_description && p.meta_description.length >= 120 && p.meta_description.length <= 160],
    ['Keyphrase in meta description', has(p.meta_description)],
    ['Keyphrase in the first 100 words', has(first100)],
    ['Keyphrase in a subheading', h2.some(x => has(x.content))],
    ['Keyphrase density 0.5–3%', density >= 0.5 && density <= 3],
    ['At least 1,300 words', words >= 1300],
    ['Excerpt written', !!p.excerpt && p.excerpt.length >= 60],
    ['Every image has alt text', imgs.length > 0 && imgs.every(i => i.alt_text && i.alt_text.length >= 20)],
    ['Keyphrase in featured image alt', has(p.featured_image?.alt_text)],
    ['Links in the text', links >= 1],
    ['FAQ section', sec.some(x => x.type === 'faq')],
    ['Categories and tags', (p.categories || []).length > 0 && (p.tags || []).length >= 3]
  ].map(([label, ok]) => ({ label, ok: !!ok }));
  return { score: Math.round(checks.filter(c => c.ok).length / checks.length * 100), checks, density: Math.round(density * 10) / 10 };
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

// ---------- Visual engine: photoreal, section-matched, never-repeating image direction ----------
// A combinatorial visual glossary. Each image gets a shot, lens, light, time of day, setting, subject, action,
// props, palette and mood chosen from topic-matched vocabularies (several billion distinct combinations), and a
// signature that must be unique inside the post, across the batch and against the user's recent history.
const V_SHOTS = {
  hero: ['wide environmental portrait', 'wide candid scene framed through a doorway', 'wide shot framed by soft foreground foliage', 'wide eye-level lifestyle scene', 'wide three-quarter scene with layered foreground and background', 'wide low-angle scene with open sky', 'wide shot along a table full of detail'],
  mid: ['medium candid shot', 'over-the-shoulder shot', 'waist-up documentary shot', 'two-person medium shot mid-conversation', 'medium shot from a slightly high angle', 'medium shot in profile with a second person softly in frame', 'eye-level candid moment'],
  detail: ['close-up of two people\'s hands working together', 'tight close-up of hands with the face softly visible behind', 'over-the-shoulder close-up of hands', 'close-up of a hand passing something to another person', 'close-up of hands with a warm smile just in frame']
};
const V_LENSES = ['35mm lens at f/2', '50mm lens at f/1.8', '85mm lens at f/1.8', '24mm lens at f/4', '28mm lens at f/2.8'];
// Who is in the picture. Heroes favour pairs and groups (connection); every image has real people.
const V_SOLO = ['a woman in her early thirties', 'a man in his forties', 'a woman in her fifties', 'a young man in his twenties', 'a woman in her late twenties', 'a man in his sixties', 'a woman in her forties', 'a man in his thirties', 'a grandmother in her seventies', 'a college-age woman'];
const V_BONDS = ['a mother and her young daughter', 'a father and his teenage son', 'a grandmother and her grandson', 'two friends in their thirties', 'a couple in their sixties', 'a young married couple', 'two neighbours of different generations', 'a mentor and a younger learner', 'a small family of four', 'three friends in their twenties', 'a father and his little girl', 'two sisters in their forties', 'a grandfather and his granddaughter', 'a husband and wife in their forties'];
const V_EMOTION = ['sharing an easy, genuine laugh', 'a quiet moment of pride in what they made', 'relief showing on their faces as it finally works', 'gentle encouragement in the way one looks at the other', 'focused, calm concentration shared between them', 'warm, unposed smiles and relaxed shoulders', 'the small joy of noticing progress together', 'a tender, reassuring touch on the shoulder', 'curious excitement, leaning in to look closer', 'the contented stillness of doing something that matters'];
const V_LIGHT = ['warm golden-hour backlight', 'soft window light from the left', 'sunlight streaming through a window with visible warmth', 'dappled light through leaves', 'gentle morning side light', 'bright airy daylight', 'low sun rim light', 'warm lamp light with cool window fill'];
const V_TIMES = ['early morning', 'mid-morning', 'late morning', 'midday', 'early afternoon', 'late afternoon', 'golden hour', 'dusk', 'blue hour', 'evening'];
const V_TIME_LIGHT = {
  morning: [['early morning', 'mid-morning', 'late morning'], ['sunlight streaming through a window with visible warmth', 'gentle morning side light', 'sunlight filtered through linen curtains', 'soft window light from the left', 'dappled light through leaves']],
  day: [['midday', 'early afternoon'], ['bright airy daylight', 'open shade on a bright day', 'dappled light through leaves', 'soft light bounced off a white wall']],
  late: [['late afternoon', 'golden hour'], ['warm golden-hour backlight', 'low sun rim light', 'late-afternoon light across the floor', 'dappled golden light through leaves']],
  evening: [['dusk', 'blue hour', 'evening'], ['warm lamp light with cool window fill', 'string lights and a last glow of daylight', 'candle-warm ambient light', 'warm practical lamps against deep blue windows']]
};
const V_PALETTES = ['lush greens with warm wood and cream', 'sun-warmed terracotta, sage and honey', 'rich garden greens with tomato red accents', 'golden light, olive and linen white', 'fresh greens, lemon yellow and natural oak', 'deep teal, brass and warm skin tones', 'berry reds, leafy greens and rustic wood', 'soft cream, blush and fresh herb green', 'navy, camel and warm amber', 'sky blue, sand and sunlit white'];
const V_MOODS = ['hopeful and full of life', 'warm, connected and real', 'quietly proud', 'joyful but unforced', 'calm and reassuring', 'energised and encouraging', 'tender and grounded', 'bright and welcoming'];
const V_SETTINGS = ['a sunlit kitchen with open shelves', 'a small city balcony overflowing with plants', 'a neighbourhood park path', 'a cosy living room with a reading chair', 'a café corner table', 'a community garden', 'a farmhouse porch', 'a busy farmers market', 'a backyard patio', 'a greenhouse', 'a riverside bench', 'a dining table after breakfast', 'a rooftop terrace', 'a bright home office by a window'];
const V_GLOSSARY = [
  'sleep|bedtime|insomnia|rest|nap|tired|fatigue | a minimalist bedroom at dawn;a reading nook with a dim lamp;a hotel-style bed with linen sheets | stretching gently beside the bed;setting a phone face-down on the nightstand;pulling back curtains to morning light | linen sheets,herbal tea,analog alarm clock,eye mask',
  'morning|routine|habit|wake|start the day|daily | a sunlit kitchen;a quiet balcony at sunrise;a tidy bathroom sink area | pouring coffee;writing in a notebook at the counter;opening a window to fresh air | coffee mug,open notebook,glass of water,houseplant',
  'gratitude|thankful|journal|journaling|reflection|reflect | a window seat with cushions;a café corner table;a porch swing | writing slowly in a journal;pausing with a pen above a page;smiling while reading an old entry | leather journal,fountain pen,warm tea,dried flowers',
  'prayer|faith|god|jesus|bible|scripture|church|spiritual|worship|devotion | a quiet church pew;a sunlit window with an open bible;a hillside at sunrise | reading scripture with a highlighter;sitting with folded hands in silence;walking toward a small chapel | open bible,wooden cross,candle,handwritten verse card',
  'stress|anxiety|anxious|overwhelm|calm|peace|breathe|breathing|mindful|mindfulness|meditat | a bright yoga studio;a lakeside dock;a quiet park bench | breathing slowly with eyes closed;resting hands on a warm mug;watching water ripple | cushion,warm mug,soft blanket,smooth stones',
  'money|budget|budgeting|saving|savings|finance|debt|spending|frugal | a dining table with papers;a home office desk;a grocery store aisle | reviewing a budget notebook with a calculator;sorting receipts into envelopes;comparing two price tags | calculator,receipts,cash envelopes,laptop with blurred spreadsheet',
  'trading|trader|stock|stocks|forex|gold|xauusd|market|invest|investing|portfolio|chart | a home trading desk with two monitors;a quiet office at dawn;a café table with a laptop | studying a candlestick chart on a monitor;writing trade notes in a notebook;closing a laptop after a session | two monitors with blurred candlestick charts,notebook with handwritten levels,coffee,desk lamp',
  'business|entrepreneur|startup|side hustle|sell|selling|marketing|brand|client|customer | a small studio workspace;a modern co-working space;a pop-up market stall | packing an order into a kraft box;sketching ideas on a whiteboard;shaking hands with a customer | kraft boxes,sticky notes,laptop,tape dispenser',
  'career|job|work|office|interview|resume|promotion|boss|meeting|productivity|focus|procrastinat | a quiet home office by a window;a bright meeting room;a library reading room | writing a focused to-do list;working with headphones on;presenting to two colleagues | planner,headphones,laptop,wall clock',
  'parent|parenting|mom|mother|dad|father|child|children|kids|toddler|baby|family | a cosy living room floor;a backyard lawn;a kitchen table at homework time | reading a picture book together;helping with homework;walking hand in hand | picture books,wooden toys,crayons,lunchbox',
  'marriage|couple|relationship|husband|wife|partner|dating|love | a farmhouse porch;a riverside bench;a small dining table by candlelight | talking over coffee;laughing while cooking together;walking arm in arm | two mugs,shared blanket,cookbook,string lights',
  'friend|friendship|community|neighbor|neighbour|lonely|loneliness|belong | a community garden;a café corner;a backyard patio | sharing a meal outdoors;planting seedlings together;talking on a park bench | shared plates,garden tools,picnic blanket,lemonade',
  'food|meal|recipe|cook|cooking|kitchen|dinner|lunch|breakfast|nutrition|eat|eating|healthy eating | a sunlit kitchen;a farmers market;a rustic dining table | chopping fresh vegetables;plating a simple meal;choosing produce at a stall | cutting board,fresh herbs,ceramic bowls,olive oil',
  'fitness|exercise|workout|gym|walk|walking|run|running|strength|yoga|stretch|movement | a home gym corner;a forest trail;a bright yoga studio | tying running shoes;holding a plank on a mat;walking briskly uphill | running shoes,yoga mat,water bottle,resistance band',
  'hydration|hydrate|drink more water|dehydrat | a kitchen counter in morning light;a gym bench;a hiking trail | filling a glass bottle at the tap;slicing lemon into a pitcher;drinking during a hike | glass bottle,lemon slices,pitcher,reusable cup',
  'vegetable|vegetables|tomato|tomatoes|harvest|veggie|kitchen garden|crop | a raised-bed backyard garden;a community allotment plot;a sunny suburban side yard;a cottage kitchen garden with a picket fence;a rooftop vegetable garden in the city;a farmhouse garden at the edge of a field | harvesting ripe tomatoes into a basket;pulling carrots and laughing at their odd shapes;tying a tomato vine to a stake;comparing two zucchini they just picked;rinsing fresh lettuce under a garden tap;carrying a full harvest basket to the kitchen | wicker harvest basket,heirloom tomatoes,garden twine,muddy boots,zucchini,fresh lettuce',
  'seed|seeds|seedling|seedlings|sow|sowing|germinat|seed starting|seed-starting | a sunny kitchen windowsill;a basement grow-light shelf;a greenhouse bench;a garage potting table;a dining table covered in newspaper;a small cold frame by the fence | pressing seeds into soil with a fingertip;labelling seed trays together;misting tiny seedlings;checking sprouts under a grow light;thinning seedlings with small scissors;transplanting a seedling into a bigger pot | seed trays,handwritten plant labels,spray mister,seed packets,grow light,small scissors',
  'soil|compost|composting|mulch|mulching|fertiliz|fertilis|worm|dirt | a backyard compost corner;a garden bed in early spring;a wheelbarrow beside a raised bed;a community garden compost area;a shed doorway with bags of mulch;a sunny lawn edge | turning compost with a pitchfork;spreading mulch around young plants;crumbling rich soil in their hands;showing a child an earthworm;mixing compost into a raised bed;testing soil with a simple kit | pitchfork,wheelbarrow,compost bin,garden gloves,bag of mulch,soil test kit',
  'container|containers|pot|pots|balcony|patio|small space|small-space|apartment garden|window box|raised bed|raised-bed | a small city balcony overflowing with pots;a brick patio with mixed containers;a fire-escape herb garden;a rooftop terrace with planters;a front stoop lined with pots;an apartment window box | repotting a plant on a newspaper-covered table;arranging pots by height;watering a window box together;moving a heavy pot on a dolly;planting herbs in a railing planter;pinching back basil | terracotta pots,watering can,railing planter,potting mix,herb seedlings,trowel',
  'indoor plant|houseplant|houseplants|indoor plants|plant care|monstera|succulent|fern | a bright living room full of houseplants;a plant-filled bathroom with a skylight;a sunny reading nook;a small apartment kitchen window;a home office with trailing pothos;a plant shop corner | wiping dust from a large leaf;checking roots while repotting;watering a fern at the sink;rotating a plant toward the light;propagating cuttings in glass jars;showing a friend a new leaf | glass propagation jars,moisture meter,plant mister,macramé hanger,ceramic planter,pruning snips',
  'water|watering|irrigat|drought|hose|rain barrel | a backyard garden at dawn;a balcony with a rain barrel;a sunny vegetable patch;a greenhouse aisle;a front-yard flower bed;a community garden tap | checking soil moisture with a finger;watering at the base of plants;filling a watering can from a rain barrel;setting up a drip hose;laughing as a hose sprays by mistake;watering seedlings gently with a rose head | watering can with rose head,rain barrel,drip hose,moisture meter,coiled garden hose,tin bucket',
  'pest|pests|aphid|slug|disease|weed|weeds|weeding|prune|pruning | a vegetable bed in late summer;a rose garden;a fruit tree in a backyard;a greenhouse bench;a garden path edge;a herb bed by the kitchen | inspecting the underside of a leaf together;pulling weeds side by side;pruning a shrub with care;hand-picking pests into a jar;tying up a drooping stem;pointing out a ladybug to a child | pruning shears,kneeling pad,small jar,magnifying glass,garden gloves,twine',
  'garden|gardening|gardener|plant|plants|grow|growing|flower|flowers|bloom|native plant|pollinator|landscap|yard|backyard|seasonal|cleanup | a cottage flower garden;a pollinator meadow in a backyard;a front yard with native plants;a garden path lined with blooms;a potting shed doorway;a garden bench under a tree | planting a native flower together;cutting fresh flowers for a vase;raking leaves into a pile;kneeling to plant bulbs;watching a bee on a flower;handing a seedling across the garden fence | flower bucket,rake,bulbs,kneeling pad,fresh-cut flowers,wooden garden tools',
  'home|declutter|clean|cleaning|organize|organise|tidy|minimal|minimalism | a bright living room;a laundry room;a tidy entryway | folding laundry into a basket;sorting items into labelled boxes;wiping a clean counter | woven baskets,labelled jars,linen towels,spray bottle',
  'travel|trip|vacation|holiday|adventure|explore|road trip | a train window seat;a mountain overlook;a coastal road | reading a paper map;looking out a train window;packing a small suitcase | paper map,passport,suitcase,camera',
  'nature|outdoors|hike|hiking|forest|beach|ocean|mountain|lake|sunrise|sunset | a forest trail;a beach at low tide;a mountain cabin porch | walking along the shoreline;resting on a rock at a viewpoint;touching tall grass | backpack,thermos,walking stick,wildflowers',
  'pet|dog|cat|puppy|kitten|animal | a sunny living room;a neighbourhood park;a backyard | walking a dog on a leash;brushing a cat;playing fetch | leash,pet bowl,chew toy,soft blanket',
  'school|student|study|studying|learn|learning|exam|homework|teacher|education|course | a library reading room;a campus lawn;a kitchen table at night | taking notes from a textbook;studying with flashcards;listening in a small class | textbooks,flashcards,highlighters,laptop',
  'technology|phone|screen|social media|digital|app|online|internet|computer | a desk with a laptop;a couch in the evening;a café table | putting a phone in a drawer;typing on a laptop;charging devices at a station | phone,laptop,charging dock,notebook',
  'doctor|wellness|wellbeing|well-being|self-care|self care|healing|recovery | a bright bathroom;a calm spa-like room;a park bench | applying hand cream;preparing a herbal tea;walking slowly in sunlight | herbal tea,towel,skincare bottles,journal',
  'grief|loss|hard times|struggle|hope|resilience|healing heart|comfort | a quiet window seat on a rainy day;a hillside at dawn;a garden bench | holding a warm mug looking outside;placing flowers on a table;hugging a friend | rain-streaked window,flowers,warm mug,soft blanket',
  'goal|goals|new year|resolution|vision board|dream|purpose|motivation | a desk with a planner;a rooftop at sunrise;a wall with pinned notes | writing goals in a planner;pinning a note to a board;looking out at the horizon | planner,pins,index cards,pen',
  'senior|aging|retirement|grandparent|elder | a farmhouse porch;a community garden;a sunny kitchen | teaching a grandchild to bake;tending tomatoes;walking with a cane in the park | photo album,reading glasses,garden hat,tea set',
  'teen|teenager|youth|young adult | a bedroom desk;a skate park;a school hallway | studying with headphones;talking with a parent on the stairs;riding a bike | backpack,headphones,sneakers,notebook',
  'beauty|skin|skincare|hair|makeup|style|fashion|outfit|wardrobe | a bright bathroom vanity;a bedroom closet;a boutique fitting room | applying moisturiser;choosing a shirt from a rail;brushing hair by a mirror | skincare bottles,wooden hangers,mirror,folded knitwear',
  'coffee|tea|cafe|café | a café counter;a home kitchen;a porch at sunrise | pouring pour-over coffee;steeping loose-leaf tea;holding a mug with both hands | ceramic mug,kettle,coffee beans,teapot',
  'read|reading|book|books|library | a library reading room;a window seat;a park under a tree | turning a page;choosing a book from a shelf;reading under a tree | stacked books,bookmark,reading glasses,tea',
  'music|sing|song|guitar|piano | a living room with a piano;a porch at dusk;a small studio | playing acoustic guitar;practising piano scales;singing with friends | acoustic guitar,sheet-free piano keys,headphones,vinyl records',
  'art|creative|creativity|paint|painting|draw|drawing|craft|hobby | a sunlit art studio;a kitchen table with supplies;a park bench | painting with watercolours;sketching in a notebook;knitting in a chair | watercolour palette,brushes,sketchbook,yarn',
  'volunteer|serve|service|give|giving|charity|help others|kindness | a food bank warehouse;a community kitchen;a neighbourhood street | packing food boxes;serving soup;carrying groceries for a neighbour | cardboard boxes,aprons,grocery bags,clipboard',
  'car|drive|driving|commute|traffic | a car interior at dawn;a train platform;a bike lane | adjusting a rear-view mirror;reading on a commuter train;cycling to work | car keys,travel mug,bike helmet,transit card',
  'weather|rain|winter|summer|spring|autumn|fall|season | a rain-streaked window;a snowy porch;a sunlit meadow | watching rain with a mug;shovelling a path;walking through fallen leaves | umbrella,wool scarf,rain boots,fallen leaves',
  'real estate|house|mortgage|rent|apartment|moving|move | an empty bright apartment;a front porch with a sold sign;a living room full of boxes | carrying a moving box;holding new keys;measuring a wall | moving boxes,house keys,tape measure,paint swatches',
  'wedding|anniversary|celebrat|party|birthday|holiday season|christmas|thanksgiving | a decorated dining room;a backyard with string lights;a church entrance | lighting candles on a table;raising glasses in a toast;wrapping a gift | string lights,candles,wrapped gifts,table linens'
].map(line => {
  const parts = line.split(' | '); const keys = parts[0].split('|').map(x => x.trim()).filter(Boolean);
  const esc2 = x => x.replace(/[.*+?^${}()[\]\\]/g, '\\$&');
  return { keys, re: new RegExp(`\\b(${keys.map(esc2).join('|')})\\w{0,3}\\b`, 'i'), settings: parts[1].split(';').map(x => x.trim()), actions: parts[2].split(';').map(x => x.trim()), props: parts[3].split(',').map(x => x.trim()) }; });


function realism(allowText) {
  return `Realism requirements: a genuine high-end editorial photograph indistinguishable from a real camera photo — natural skin texture, real expressions caught mid-moment (not posed, not looking at the camera), realistic hands with five fingers, correct anatomy, believable fabric, soil, food and surface textures, accurate reflections and shadows, true-to-life vibrant colour, rich layered detail from foreground to background. Not an illustration, not a cartoon, not flat vector art, not a 3D render, no plastic or airbrushed look. ${allowText ? 'The ONLY text allowed is the headline described above, spelled exactly; no other words, labels, logos, watermarks or brand names.' : 'No text, letters, numbers, captions, signage, watermarks, logos or brand names anywhere in the frame; screens show only soft blurred shapes.'}`;
}
function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const wordsOf = s => new Set((String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []));
const jaccard = (a, b) => { const A = wordsOf(a), B = wordsOf(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
const firstSentences = (t, n = 2) => (stripHtml(t).replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) || [stripHtml(t)]).slice(0, n).map(x => x.trim()).join(' ').trim();
const isDefaultPrompt = s => !s || /^Editorial photograph for a blog article titled/.test(s) || String(s).length < 140;
const CONTRAST_RE = /\bvs\.?\b|\bversus\b|buy and (what to )?skip|do'?s and don'?ts|\bmistakes?\b|before and after|right (way|and wrong)|\bheal\b.*\bharm\b|good (and|vs) bad/i;
// ---------- Featured cover: category-aware, title in the picture (magazine / Pinterest-cover style) ----------
const COVER_THEMES = [
  [/garden|plant|soil|compost|seed|harvest|mulch|flower|lawn|yard/i, 'a lush, sun-drenched garden overflowing with healthy plants, rich dark soil, terracotta pots, a basket of fresh harvest and well-used garden tools on weathered wood', ['#2e7d32', '#8b1e1e'], 'a neglected, weedy bed with cracked dry soil, wilted plants and tangled hoses under flat grey light'],
  [/food|nutrition|recipe|meal|diet|eat|cook|kitchen|heal|snack|drink/i, 'an abundant, glowing rustic table spread of fresh, colourful whole foods — leafy greens, berries, citrus, grains, olive oil — on warm wood', ['#2e7d32', '#8b1e1e'], 'greasy fast food, sugary soda, chips, donuts and pizza boxes on a dark table under harsh red neon'],
  [/trad|forex|gold|xauusd|stock|invest|crypto|market|portfolio/i, 'a sleek trading desk at dawn with several monitors of softly blurred candlestick charts, gold accents, a notebook of handwritten price levels and a steaming coffee', ['#b8860b', '#7f1d1d'], 'chaotic red charts, scattered sticky notes, cold coffee and an overflowing desk at night'],
  [/money|budget|financ|debt|saving|frugal|income|tax/i, 'a warm, organised kitchen-table money session with a budget notebook, calculator, neatly sorted envelopes, a jar of coins and coffee', ['#1e5631', '#7f1d1d'], 'scattered unpaid bills, overdue notices, receipts and an empty wallet under a harsh lamp'],
  [/faith|god|jesus|bible|pray|church|scripture|devotion|worship|spiritual/i, 'a peaceful, light-filled scene with an open Bible, a journal, a warm mug and golden morning sun pouring through a window', ['#b8860b', '#3b3b58'], 'a dim, cluttered room lit only by a phone screen, with an unopened Bible gathering dust'],
  [/parent|family|kid|child|mom|mother|dad|father|baby|toddler|teen/i, 'a warm, lively family home full of everyday life — a kitchen table with drawings, snacks, books and small joyful details', ['#1565c0', '#8b1e1e'], 'a chaotic, cluttered room with screens glowing and toys everywhere in cold light'],
  [/fitness|workout|exercise|running|yoga|strength|gym|walk/i, 'an energetic, sunlit training space with a yoga mat, weights, running shoes and fresh water, full of motion', ['#e65100', '#37474f'], 'a dark couch corner with takeaway boxes, a remote and unused running shoes'],
  [/mind|stress|anxiety|calm|mental|sleep|rest|self-care|wellbeing|wellness|gratitude|journal/i, 'a calm, softly lit sanctuary with journals, herbal tea, plants, a cosy blanket and gentle morning light', ['#00695c', '#4a148c'], 'a messy desk at midnight with piles of paper, a glowing phone and cold coffee'],
  [/home|clean|declutter|organi|decor|house|laundry/i, 'a bright, beautifully organised home with woven baskets, plants, folded linens and soft natural textures', ['#00796b', '#6d4c41'], 'a cluttered, chaotic room with piles of laundry and boxes in grey light'],
  [/business|entrepreneur|marketing|career|work|productiv|side hustle|brand|sales/i, 'a vibrant creative workspace with a laptop, notebooks, sticky notes, product samples and coffee in golden light', ['#1565c0', '#b71c1c'], 'a chaotic desk with tangled cables, piles of paper and missed-deadline notes'],
  [/travel|trip|vacation|adventure|road/i, 'a sweeping travel scene with a paper map, a packed bag, a camera and a breathtaking view', ['#0277bd', '#bf360c'], ''],
  [/relationship|marriage|love|dating|friend|couple/i, 'a warm, intimate scene of shared life with candlelight, two mugs, handwritten notes and soft textures', ['#ad1457', '#37474f'], ''],
  [/pet|dog|cat|puppy|kitten/i, 'a joyful home scene with a happy pet, toys, treats and cosy textures', ['#ef6c00', '#455a64'], ''],
  [/tech|\bai\b|app|software|digital|computer|online/i, 'a clean, modern tech workspace with glowing screens of soft abstract shapes, cables tidied and warm desk light', ['#1565c0', '#263238'], '']
];
function coverTheme(p) {
  const hay = `${(p.categories || []).join(' ')} ${p.title} ${p.primary_keyword} ${(p.tags || []).join(' ')}`;
  return COVER_THEMES.find(([re]) => re.test((p.categories || []).join(' '))) || COVER_THEMES.find(([re]) => re.test(hay)) || [null, 'a rich, abundant, sunlit lifestyle scene with layered real-world details that say exactly what the article is about', ['#1565c0', '#8b1e1e']];
}
const shortPhrase = t => { const w = stripHtml(String(t || '')).replace(/[*_[\]()]/g, '').replace(/[.!?,:;]+$/, '').split(/\s+/).filter(Boolean); let o = w.slice(0, 4); while (o.length > 1 && /^(a|an|the|to|of|and|or|in|on|for|with|your|every)$/i.test(o[o.length - 1])) o.pop(); return o.join(' '); };
function coverPrompt(p, choice, o = {}) {
  const style = o.coverStyle || (o.heroText === false ? 'photo' : 'full');
  const [, theme, [c1, c2], wrongSide] = coverTheme(p);
  const cat = (p.categories || [])[0] || p.primary_keyword || 'lifestyle';
  const H = heroHeadline(p);
  const split = CONTRAST_RE.test(p.title);
  const vs = split && p.title.match(/^(.*?)\s+(?:vs\.?|versus)\s+(.*)$/i);
  const takeaways = (p.sections || []).find(x => x.type === 'takeaways')?.items || [];
  const notes = (p.cover_notes?.length ? p.cover_notes.map(shortPhrase) : takeaways.filter(t => stripHtml(t).split(/\s+/).length <= 4).map(shortPhrase)).filter(x => x && x.length <= 28).slice(0, 3);
  const tagline = clip(p.hero_tagline || '', 48);
  const people = `${choice.people} ${choice.action}, sharing a genuine, candid moment (${choice.emotion}) within the scene, placed so they never cover the lettering`;
  const scene = split
    ? `Split composition with a torn-paper divide down the middle: the left side is bright, abundant and hopeful — ${theme}, with ${people}; the right side is darker, moodier and messier, showing the wrong way for this topic${wrongSide ? ` — ${wrongSide}` : ''}.`
    : `${theme[0].toUpperCase() + theme.slice(1)}, tailored precisely to "${p.title}", with ${people}.`;
  if (style === 'photo') return `Photorealistic, vibrant editorial header photograph for a ${cat} article titled "${p.title}". ${scene} ${choice.light}, ${choice.lens}, rich layered detail. ${realism(false)}`;
  const headlineLine = vs && style === 'full'
    ? `Typography: huge bold hand-painted white brush-script lettering. On the left over a painted ${c1} brush-stroke banner: "${clean0(vs[1])}". A bold "vs." in the centre. On the right over a painted ${c2} brush-stroke banner: "${clean0(vs[2])}".`
    : `Typography: the headline "${H}" in huge, bold, hand-painted white brush-script lettering over a painted ${split ? `${c1} and ${c2}` : c1} brush-stroke banner, dominant in the upper third, like a premium magazine or Pinterest cover.`;
  const extra = style === 'full' ? [
    tagline ? `Beneath the headline, a small clean uppercase sans-serif tagline with generous letter-spacing reading exactly "${tagline}".` : '',
    notes.length ? `Inside the scene, ${notes.length} small handwritten details (on a chalkboard, a note card or a notebook page with check marks) reading exactly: ${notes.map(n => `"${n}"`).join(', ')}.` : ''
  ].filter(Boolean).join(' ') : '';
  return `Premium blog cover image, landscape 3:2, photorealistic and richly styled — it must instantly read as a ${cat} article about "${p.title}".
Scene: ${scene}
${headlineLine} ${extra}
Every piece of text is spelled exactly as given, crisp and fully legible; no other words, no logos, no brand names, no watermarks.
Look: warm, sun-drenched natural light (${choice.light}), vivid true-to-life colour, extremely high detail, layered foreground-to-background abundance, shallow depth of field at the edges, shot on a full-frame camera with a ${choice.lens}. Real textures: wood grain, soil, leaves, fabric, skin. Not an illustration, not a cartoon, not flat vector art, not a 3D render.`;
}
function heroHeadline(p) {
  // The post title goes on the cover. Only very long titles fall back to ChatGPT's hero_text or the part before the colon.
  const title = clean0(p.title);
  if (title.split(/\s+/).length <= 9) return title;
  if (p.hero_text && clean0(p.hero_text).split(/\s+/).length <= 9) return clean0(p.hero_text);
  const head = title.split(/[:—–]\s|\s-\s/)[0];
  return head.split(/\s+/).length <= 9 ? head : title.split(/\s+/).slice(0, 8).join(' ');
}
function clean0(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// Text of the section an image sits in: nearest heading above + paragraphs until the next heading.
function sectionContext(sections, idx) {
  let h = idx; while (h >= 0 && sections[h].type !== 'heading') h--;
  const heading = h >= 0 ? sections[h].content : '';
  const texts = [];
  for (let i = h + 1; i < sections.length && sections[i].type !== 'heading'; i++) if (['paragraph', 'intro', 'callout', 'list', 'checklist'].includes(sections[i].type)) texts.push(sections[i].content || (sections[i].items || []).join('. '));
  if (!texts.length) for (let i = idx + 1; i < sections.length && texts.length < 2; i++) if (sections[i].type === 'paragraph') texts.push(sections[i].content);
  return { heading, text: texts.join(' ') };
}

// Turn the first practical instruction in a section into a visible action ("Check moisture with a finger…" → "checking moisture with a finger…").
const VERBS = 'add apply arrange ask bake begin block breathe build buy call carry change check choose clean clear compare cook count cover cut dig divide drink feed fill fix fold gather give grow harvest hold keep label lay lift list look make map measure mix move note open pack pair pick place plan plant pour prep prepare press prune pull put read record remove repot rinse rotate save set share sit slice sort sow spread start stir store swap take test tie track trim try turn use walk wash water weed wipe write'.split(' ');
function ing(v) { v = v.toLowerCase(); if (/ie$/.test(v)) return v.slice(0, -2) + 'ying'; if (/[^aeiou]e$/.test(v) && v !== 'be') return v.slice(0, -1) + 'ing'; if (/^(cut|dig|set|sit|put|plan|prep|swap|trim|stir|begin|map|pat|skip|stop|drop|shop)$/.test(v)) return v + v.slice(-1) + 'ing'; return v + 'ing'; }
const ABSTRACT = new Set('signal signals time habit habits routine approach plan step steps decision decisions idea ideas thing things way ways result results progress goal goals option options problem problems issue issues mindset system systems process adjustment change changes pattern patterns evidence anxiety'.split(' '));
let CONCRETE = null;
function concreteWords() {
  if (CONCRETE) return CONCRETE;
  CONCRETE = new Set('finger fingers hand hands soil pot pots plant plants leaf leaves seed seeds water tray trays label labels basket notebook journal phone table jar jars bed beds mulch compost hose can tomato tomatoes root roots stem stems flower flowers bowl pan shoes mat calendar receipts timer chart map sink window shelf box boxes bag bags glove gloves scissors shears trowel bucket stake twine vine fruit herbs basil lettuce carrots mug tea coffee book books pen desk laptop bottle bench fence ladder broom rake shovel spade wheelbarrow sprout sprouts seedling seedlings bulb bulbs weed weeds bloom blooms vegetables salad knife board'.split(' '));
  for (const g of V_GLOSSARY) for (const t of [...g.props, ...g.actions]) for (const w of t.toLowerCase().match(/[a-z]{3,}/g) || []) if (!ABSTRACT.has(w) && !/ing$/.test(w) && !['garden', 'together', 'with', 'their', 'the', 'and', 'into', 'from'].includes(w)) CONCRETE.add(w);
  return CONCRETE;
}
function actionFrom(text) {
  const sents = stripHtml(String(text || '').replace(/\*\*[^*]+\*\*:?/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')).split(/(?<=[.!?])\s+/);
  for (const raw of sents) {
    const t = raw.trim().replace(/^(first|then|next|finally|instead|also|now),?\s+/i, '');
    const w = t.split(/\s+/)[0]?.toLowerCase();
    if (!w || !VERBS.includes(w) || /\byou\b/i.test(t.split(/\s+/).slice(1).join(' '))) continue;
    let a = `${ing(w)} ${t.split(/\s+/).slice(1).join(' ')}`.replace(/[.!?]+$/, '').split(/[,;:—–]| so | because | instead | before | until /)[0];
    a = a.replace(/\byour\b/gi, 'their').replace(/\byou\b/gi, 'them').replace(/\byourself\b/gi, 'themselves').trim();
    const words = a.split(/\s+/);
    const cw = concreteWords();
    if (words.length >= 3 && words.length <= 12 && words.some(x => cw.has(x.toLowerCase().replace(/[^a-z]/g, '')))) return a;
  }
  return '';
}

function artDirect(p, o = {}) {
  const used = o.usedSigs instanceof Set ? o.usedSigs : new Set(o.usedSignatures || []);
  const s = p.sections || [];
  const intro = s.find(x => x.type === 'intro')?.content || p.excerpt || '';
  const list = [];
  if (p.featured_image) list.push({ img: p.featured_image, role: 'hero', ctx: { heading: p.title, text: `${p.excerpt || ''} ${intro}` } });
  s.forEach((x, i) => { if (x.type === 'image') list.push({ img: x, role: list.filter(l => l.role !== 'hero').length % 2 ? 'detail' : 'mid', ctx: sectionContext(s, i) }); });
  const local = { settings: new Set(), times: new Set(), people: new Set(), shots: new Set(), props: new Set() };
  const LENS_BY = { hero: ['24mm lens at f/4', '28mm lens at f/2.8', '35mm lens at f/2'], mid: ['35mm lens at f/2', '50mm lens at f/1.8', '85mm lens at f/1.8'], detail: ['50mm lens at f/2', '85mm lens at f/1.8', '100mm macro lens at f/4'] };
  const usedEntries = new Map();
  const entryUse = o.entryUse instanceof Map ? o.entryUse : new Map();
  const actionUse = o.actionUse instanceof Set ? o.actionUse : new Set();
  const briefs = [];
  const postAll = `${(p.categories || []).join(' ')} ${(p.tags || []).join(' ')} ${s.map(x => x.content || (x.items || []).join(' ')).join(' ')}`;
  for (const { img, role, ctx } of list) {
    const hi = role === 'hero' ? `${p.title} ${p.primary_keyword || ''} ${(p.categories || []).join(' ')} ${img.subject || ''}` : `${img.concept || ''} ${ctx.heading} ${img.subject || ''}`;
    const lo = role === 'hero' ? `${p.excerpt || ''} ${intro}` : ctx.text;
    const tail = `${p.title} ${p.primary_keyword || ''} ${(p.secondary_keywords || []).join(' ')} ${(p.categories || []).join(' ')}`;
    const count = (re, t) => (String(t).match(new RegExp(re.source, 'gi')) || []).length;
    // broad catch-all concepts (e.g. plain "garden") count half, so the specific concept in a title wins
    const scored = V_GLOSSARY.map(g => ({ g, score: (count(g.re, hi) * (role === 'hero' ? 12 : 4) + count(g.re, lo) * (role === 'hero' ? 0.3 : 1) + count(g.re, tail) * 0.5) * (g.keys[0] === 'garden' ? 0.5 : 1) + Math.min(2, count(g.re, postAll) * 0.05) - (usedEntries.get(g) || 0) * 1.5 - (entryUse.get(g) || 0) * 0.25 })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    // rotate among close contenders so a batch on one niche still gets different scenes
    const close = scored.filter(x => x.score >= (scored[0]?.score || 0) * 0.55).slice(0, 3);
    const entry = role === 'hero' ? (scored[0]?.g || null) : close.length ? close[hash(`${p.post_id}|${img.filename}|entry`) % close.length].g : null;
    if (entry) entryUse.set(entry, (entryUse.get(entry) || 0) + 1);
    if (entry) usedEntries.set(entry, (usedEntries.get(entry) || 0) + 1);
    let choice = null;
    for (let salt = 0; salt < 80 && !choice; salt++) {
      const r = mulberry(hash(`${p.post_id}|${img.filename}|${salt}`));
      const at = a => a[Math.floor(r() * a.length)];
      const j = entry ? Math.floor(r() * entry.settings.length) : 0;
      const hiWords = wordsOf(hi);
      const onTopic = entry ? entry.settings.map((x, k) => [x, k]).filter(([x]) => [...wordsOf(x)].some(w => hiWords.has(w))) : [];
      const jj = role === 'hero' && onTopic.length && salt < 30 ? onTopic[Math.floor(r() * onTopic.length)][1] : j;
      const setting = img.setting || (entry && salt < 40 ? entry.settings[jj] : at(V_SETTINGS));
      let fromText = role !== 'hero' && salt < 60 ? actionFrom(ctx.text) : '';
      if (fromText && actionUse.has(fromText.toLowerCase())) fromText = ''; // the same instruction in many posts must not become the same photo
      const freshActs = entry ? entry.actions.filter(x => !actionUse.has(x.toLowerCase())) : [];
      const action = fromText || (entry ? (role === 'hero' && entry.actions[jj] && !actionUse.has(entry.actions[jj].toLowerCase()) ? entry.actions[jj] : at(freshActs.length ? freshActs : entry.actions)) : 'working on it together');
      const fresh = entry ? entry.props.filter(x => !local.props.has(x)) : [];
      const pool2 = fresh.length >= 2 ? fresh : (entry ? entry.props : []);
      const props = entry ? [...new Set([at(pool2), at(pool2), at(pool2)])] : [at(['a ceramic mug', 'fresh flowers', 'a notebook'])];
      const cue = `${setting} ${action} ${role === 'hero' ? hi : ctx.heading}`;
      const band = /morning|dawn|sunrise|breakfast|wak(e|ing)|coffee/i.test(cue) ? 'morning' : /evening|night|dusk|sunset|candle|bedtime|string lights|lamp/i.test(cue) ? 'evening' : at(['morning', 'day', 'late', 'late', 'morning', 'day']);
      const [times, lights] = V_TIME_LIGHT[band];
      const solo = role === 'mid' && r() < 0.3;
      const people = img.people && !img.generic_prompt ? img.people : solo ? at(V_SOLO) : at(V_BONDS);
      const c = {
        kind: role, shot: img.shot || at(V_SHOTS[role].filter(x => !solo || !/two-person|two people|another person|second person/.test(x))), lens: img.lens || at(LENS_BY[role]),
        time: img.time_of_day || at(times), light: img.lighting || at(lights), setting, people, action, props,
        emotion: img.emotion && !img.generic_prompt ? img.emotion : at(V_EMOTION), palette: img.palette || at(V_PALETTES), mood: at(V_MOODS)
      };
      const sig = `${c.setting}|${c.shot}|${c.time}`.toLowerCase();
      const clash = used.has(sig) || local.settings.has(c.setting) || local.shots.has(c.shot) || local.people.has(c.people) || local.times.has(c.time);
      if (!clash || salt === 79) choice = { ...c, sig };
    }
    local.settings.add(choice.setting); local.shots.add(choice.shot); local.times.add(choice.time); local.people.add(choice.people); choice.props.forEach(x => local.props.add(x)); actionUse.add(String(choice.action).toLowerCase());
    used.add(choice.sig);
    const summary = clip(firstSentences(String(ctx.text).replace(/\*\*|\*|\[([^\]]+)\]\([^)]+\)/g, (m, t) => t || ''), 2), 240);
    const cap = x => x[0].toUpperCase() + x.slice(1);
    const scene = `${choice.people} ${choice.action}`;
    const art = `${cap(choice.shot)}: ${scene}, ${onIn(choice.setting)} ${choice.setting}, ${choice.time}, ${choice.light}. Human connection: ${choice.emotion} — a real moment between real people, candid and unposed. Shot on a full-frame camera with a ${choice.lens}; layered composition with rich foreground detail (${choice.props.join(', ')}) and a softly detailed background. Colour: ${choice.palette}, vibrant but natural. Mood: ${choice.mood}.`;
    const heroText = role === 'hero' && o.heroText ? heroHeadline(p) : '';
    const contrast = role === 'hero' && CONTRAST_RE.test(p.title) ? ' Composition: a split scene with a clear, natural divide — one side bright, abundant and hopeful showing the right way, the other side darker and messier showing the wrong way, like a before-and-after magazine spread, with the people on the bright side.' : '';
    const headline = heroText ? ` Headline: large, bold, hand-painted brush-script lettering integrated into the scene like a premium magazine cover, reading exactly "${heroText}" — spelled exactly, fully legible, placed over a calm area so no faces are covered.` : '';
    const purpose = role === 'hero' ? `This is the featured image for "${p.title}". It must make a reader feel the article's promise at a glance: abundant, warm, human and richly detailed, working as a wide 3:2 header.${contrast}${headline}` : `This image sits inside the section "${ctx.heading}" of "${p.title}" and must show that section's specific idea through the people in it${summary ? `: ${summary}` : '.'}`;
    const base = isDefaultPrompt(img.prompt) || img.generic_prompt ? '' : String(img.prompt).trim();
    const camera = `Camera: ${choice.lens}, ${choice.light}; layered composition with rich foreground detail; colour ${choice.palette}, vibrant but natural. Human connection must read clearly: genuine emotion, candid, not looking at the camera.`;
    briefs.push({ img, base, art, camera, purpose, sig: choice.sig, choice, heroText, scene });
  }
  briefs.forEach((b, i) => {
    const others = briefs.filter((_, j) => j !== i);
    const tooClose = b.base && others.some(x => x.base && jaccard(b.base, x.base) > 0.45);
    const avoid = others.map(x => `${x.choice.shot} in ${x.choice.setting}`).join('; ');
    // ChatGPT's own detailed brief is kept as the scene; Aura only adds camera and realism so nothing contradicts it
    const core = b.base ? (tooClose ? `${b.base}\nComposition override so this image is clearly different from the others: ${b.art}` : `${b.base}\n${b.camera}`) : b.art;
    b.img.render_prompt = b.img.featured || b === briefs[0] && p.featured_image === b.img ? coverPrompt(p, b.choice, o) : `Photorealistic, vibrant editorial lifestyle photograph. ${core}\n${b.purpose}\nMust look clearly different from the other images in this article (${avoid || 'none'}).\n${realism(false)}`;
    b.img.sig = b.sig;
    b.img.art = { scene: b.scene, shot: b.choice.shot, setting: b.choice.setting, time_of_day: b.choice.time, lighting: b.choice.light, lens: b.choice.lens, palette: b.choice.palette, headline: b.heroText || '' };
    b.img.art_alt = clip(`${cap1(b.scene)} ${onIn(b.choice.setting)} ${b.choice.setting}`, 95);
  });
  return briefs.length;
}
const onIn = st => /\b(balcony|porch|terrace|dock|bench|path|trail|patio|rooftop|overlook|lawn|beach|sidewalk|road|street|shoreline|hillside|pew|platform|swing)\b/i.test(st) && !/\binterior\b/i.test(st) ? 'on' : 'in';
const cap1 = x => String(x || '').charAt(0).toUpperCase() + String(x || '').slice(1);

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

// Real photos carry far more detail per pixel than flat drawings made with code (the "placeholder art" ChatGPT
// produces when it cannot generate photos). Those are dropped on import so Aura generates real photos instead.
function imageDims(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
  if (b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), type: 'jpeg' };
      i += 2 + len;
    }
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { type: 'webp' };
  return null;
}
// Photos in the ZIP whose names don't match the manifest (e.g. "image_3.png") fill the empty photo spots in order:
// post 1 featured, inline-1, inline-2, then post 2… The spot takes the photo's real file type.
function assignLooseImages(rawPosts, assetMap, existing = []) {
  const slots = [];
  for (const raw of rawPosts) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.featured_image && typeof raw.featured_image === 'object') slots.push(raw.featured_image);
    for (const sec of Array.isArray(raw.sections) ? raw.sections : []) if (sec && String(sec.type).toLowerCase() === 'image') slots.push(sec);
  }
  const fname = o => String(o.filename || o.file || '').split('/').pop();
  const referenced = new Set(slots.map(o => lc(fname(o))).filter(Boolean));
  const have = new Set([...assetMap.keys(), ...existing.map(lc)]);
  const loose = [...assetMap.entries()].filter(([k]) => !referenced.has(k)).sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { numeric: true }));
  const empty = slots.filter(o => !fname(o) || !have.has(lc(fname(o))));
  let n = 0;
  for (const [k, a] of loose) {
    const slot = empty.shift(); if (!slot) break;
    const ext = a.name.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
    const base = (fname(slot) || `photo-${n + 1}.jpg`).replace(/\.[a-z0-9]+$/i, '');
    const name = `${base}.${ext}`;
    slot.filename = name; delete slot.file;
    assetMap.delete(k); assetMap.set(lc(name), { ...a, name, mime: mimeFor(name) });
    n++;
  }
  return n;
}
function looksPlaceholder(buf) {
  const d = imageDims(buf);
  if (!d?.w || !d?.h) return false;
  const px = d.w * d.h, bpp = buf.length / px;
  if (px < 250000) return true; // tiny images are never usable blog photos
  return d.type === 'jpeg' ? bpp < 0.075 : d.type === 'png' ? bpp < 0.3 : false;
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

// Package-level repair: ChatGPT often reuses one templated prompt / alt / caption for every post.
function packageProfile(bases) {
  const imgs = bases.flatMap(b => [b.featured_image, ...b.sections.filter(x => x.type === 'image')].filter(Boolean).map(i => ({ i, post: b.post_id })));
  const count = f => { const m = new Map(); for (const { i } of imgs) { const k = lc(f(i)); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const alts = count(i => i.alt_text), caps = count(i => i.caption);
  const dupAlts = new Set([...alts].filter(([, n]) => n > 1).map(([k]) => k)), dupCaps = new Set([...caps].filter(([, n]) => n > 1).map(([k]) => k));
  // A prompt that is nearly the same as prompts in other posts is a template, not direction: rebuild it.
  const strip = (t, b) => { let x = String(t || ''); for (const w of [b.title, b.primary_keyword, ...(b.secondary_keywords || [])].filter(Boolean)) x = x.split(w).join(' '); return x; };
  const byPost = new Map(bases.map(b => [b.post_id, b]));
  let generic = 0;
  const sample = imgs.slice(0, 400);
  for (const a of sample) {
    if (!a.i.prompt) continue;
    const ta = strip(a.i.prompt, byPost.get(a.post));
    const twins = sample.filter(b => b.post !== a.post && b.i.prompt && jaccard(ta, strip(b.i.prompt, byPost.get(b.post))) > 0.7).length;
    if (twins >= 2) { a.i.generic_prompt = true; generic++; }
  }
  return { dupAlts, dupCaps, generic };
}

function preparePosts(rawPosts, assetNames, options) {
  const seen = new Set();
  const bases = rawPosts.map(raw => normalizePost(raw));
  const prof = packageProfile(bases);
  options = { ...options, assetNames, heroText: options.heroText !== false, dupAlts: prof.dupAlts, dupCaps: prof.dupCaps, entryUse: new Map(), actionUse: new Set(), usedSigs: new Set(Array.isArray(options.usedSignatures) ? options.usedSignatures.slice(-2000) : []) };
  return rawPosts.map((raw, ri) => {
    const base = bases[ri];
    if ([base.featured_image, ...base.sections].some(x => x?.generic_prompt)) base._genericPrompts = true;
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
const block = (name, html, attrs) => `<!-- wp:${name}${attrs ? ' ' + JSON.stringify(attrs) : ''} -->\n${html}\n<!-- /wp:${name} -->`;

// ---------- Ad placement engine (non-invasive: top, side, in-content, text links, end list) ----------
const AD_DEFAULTS = { top: true, topPosition: 'after-intro', side: true, sideMax: 2, textLinks: true, textLinkMax: 3, end: true, endMax: 3, disclosure: true,
  disclosureText: 'This post contains affiliate links. If you buy through them, we may earn a small commission at no extra cost to you.', wordsPerAd: 350 };
const AD_REL = 'sponsored nofollow noopener';
// Scoped CSS. Only sent when the WordPress user has unfiltered_html (otherwise WordPress would strip the tag).
const AD_CSS = `.aura-ad a{text-decoration:none}.aura-ad a:hover{text-decoration:underline}
@media (min-width:960px){.aura-ad--side{float:right!important;width:260px!important;max-width:42%!important;margin:.3em 0 1.2em 28px!important}}
.aura-ad--side~h2,.aura-ad--side~h3,.aura-ad--side~figure,.aura-ad--side~.aura-ad--inline,.aura-ad--side~.aura-ad--end,.aura-ad--side~.aura-checklist{clear:both}
@media (max-width:600px){.aura-ad--top{flex-direction:column;align-items:flex-start!important}}`;
const STOPW = new Set('the and for with your you that this from have are was were will what when how why who which their them they our out about into more most very just than then also can could should would been being over under after before other some such only each every much many these those here there where while best good great need make made take time help'.split(' '));
const toks = s => (String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => !STOPW.has(w)).map(w => w.replace(/ies$/, 'y').replace(/(ing|es|s)$/, ''));
const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normLib(ads) {
  return (ads || []).filter(a => a && a.enabled !== false && (a.url || a.html)).map((a, i) => {
    const kwPhrases = [...new Set(arr(a.keywords).map(x => x.toLowerCase()).filter(x => x.length > 2))];
    const pl = arr(a.placements).map(x => x.toLowerCase());
    return { ...a, id: slug(a.id || a.name || a.label || `ad-${i + 1}`), kwPhrases,
      kwTok: new Set(toks([a.name, a.label, a.category, a.text, ...kwPhrases].join(' '))),
      placements: new Set(pl.length ? pl : ['top', 'side', 'inline', 'text', 'end']) };
  });
}
function relevance(ad, text) {
  const low = String(text).toLowerCase(), tk = new Set(toks(text)); let sc = 0;
  for (const ph of ad.kwPhrases) if (new RegExp(`\\b${escRe(ph)}`, 'i').test(low)) sc += 3;
  for (const t of ad.kwTok) if (tk.has(t)) sc += 1;
  return sc;
}
const nonEmpty = (o, ks) => Object.fromEntries(ks.filter(k => o[k]).map(k => [k, o[k]]));

function planAds(p, o = {}) {
  const L = { ...AD_DEFAULTS, ...(o.adLayout || {}) };
  const lib = normLib(o.ads), byId = new Map(lib.map(a => [a.id, a]));
  const s = p.sections || [];
  const postText = [p.title, p.primary_keyword, ...(p.secondary_keywords || []), ...(p.categories || []), ...(p.tags || [])].join(' ');
  const uses = new Map(), use = a => a?.id && uses.set(a.id, (uses.get(a.id) || 0) + 1);
  const choose = (text, place, { exclude = new Set(), minScore = -Infinity, minRel = 0 } = {}) => {
    const c = lib.filter(a => a.placements.has(place) && !exclude.has(a.id) && (!minRel || relevance(a, `${text} ${postText}`) >= minRel)).map(a => ({ a, sc: relevance(a, `${text} ${postText}`) * 2 + relevance(a, text) - (uses.get(a.id) || 0) * 5 + (hash(`${p.slug}|${a.id}|${place}`) % 97) / 1000 }))
      .filter(x => x.sc >= minScore).sort((x, y) => y.sc - x.sc);
    return c[0]?.a || null;
  };
  const secText = i => { const c = sectionContext(s, i); return `${c.heading} ${c.text}`; };
  const words = p.standard?.stats?.words || countWords(s.map(x => [x.content, ...(x.items || [])].join(' ')).join(' '));
  let budget = Math.max(2, Math.round(words / Math.max(150, Number(L.wordsPerAd) || 350)));
  const plan = { L, lib, byId, top: null, topAt: -1, side: new Map(), inline: new Map(), end: [], uses };

  // 1. Ad sections written into the post (the standard's two slots + any placed by ChatGPT)
  s.forEach((x, i) => {
    if (x.type !== 'ad') return;
    let ad = null;
    if (x.html) ad = { html: x.html };
    else if (x.ad_id && byId.get(slug(x.ad_id))) ad = { ...byId.get(slug(x.ad_id)), ...nonEmpty(x, ['label', 'text', 'cta']) };
    else if (x.url) ad = { ...x };
    else { const place = x.placement === 'side' ? 'side' : 'inline'; ad = choose(secText(i), place, { exclude: new Set([...uses.keys()]) }) || choose(secText(i), place); }
    use(ad); plan.inline.set(i, { ad, kind: x.placement === 'side' ? 'side' : 'inline' }); budget--;
  });
  if (!lib.length) return plan;
  const intro = s.findIndex(x => x.type === 'intro');
  // 2. Slim banner near the top
  if (L.top && budget > 0) {
    const topText = `${p.title} ${intro > -1 ? s[intro].content : ''}`;
    const a = choose(topText, 'top', { exclude: new Set([...uses.keys()]), minRel: 2 }) || choose(topText, 'top', { minRel: 2 });
    if (a) { const tk = s.findIndex(x => x.type === 'takeaways'); plan.top = a; plan.topAt = L.topPosition === 'before-intro' ? -1 : Math.max(0, tk === intro + 1 ? tk : intro); use(a); budget--; }
  }
  // 3. Side cards beside long, ad-free H2 sections, spaced apart
  if (L.side && budget > 0) {
    const adIdx = [...plan.inline.keys(), plan.topAt];
    const cands = [];
    s.forEach((x, i) => {
      if (x.type !== 'heading' || x.level !== 2 || TAKEAWAY_RE.test(x.content) || /checklist/i.test(x.content)) return;
      let end = i + 1; while (end < s.length && !(s[end].type === 'heading' && s[end].level === 2)) end++;
      const body = s.slice(i + 1, end);
      if (body.some(b => ['ad', 'checklist'].includes(b.type))) return;
      if (countWords(body.map(b => b.content || (b.items || []).join(' ')).join(' ')) < 150) return;
      if (adIdx.some(k => Math.abs(k - i) <= 2)) return;
      cands.push(i);
    });
    const picked = [];
    for (const i of cands.map(i => ({ i, a: choose(secText(i), 'side', { exclude: new Set([...uses.keys()]), minRel: 2 }) })).filter(x => x.a).sort((x, y) => relevance(y.a, secText(y.i)) - relevance(x.a, secText(x.i)))) {
      if (picked.length >= Math.min(Number(L.sideMax) || 0, budget)) break;
      if (picked.some(k => Math.abs(k - i.i) < 4) || (uses.get(i.a.id) || 0) > 0) continue;
      picked.push(i.i); plan.side.set(i.i, i.a); use(i.a); budget--;
    }
  }
  // 4. Short "Recommended resources" list at the very end (relevant or already-featured ads only)
  if (L.end) {
    const all = `${postText} ${s.map(x => x.content || '').join(' ')}`;
    const phraseHits = a => a.kwPhrases.filter(ph => new RegExp(`\\b${escRe(ph)}`, 'i').test(all)).length;
    plan.end = lib.filter(a => a.placements.has('end') && a.url && (uses.has(a.id) || phraseHits(a) >= 2))
      .sort((a, b) => phraseHits(b) - phraseHits(a)).slice(0, Math.max(0, Number(L.endMax) || 0));
    if (plan.end.length < 2) plan.end = [];
  }
  return plan;
}

// Inline markdown + affiliate links: [anchor](aff:ID) resolves from the library; keywords auto-link sparingly.
function inlineRich(s, rc, allowAuto) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\(aff:([\w.-]+)\)/g, (m, a, id) => {
    const ad = rc?.plan.byId.get(slug(id));
    if (!ad?.url) return a;
    rc.affiliate = true; rc.linked.add(ad.id); rc.linksUsed++;
    return `<a href="${esc(ad.url)}" target="_blank" rel="${AD_REL}">${a}</a>`;
  });
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, a, u) => `<a href="${u}">${a}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  if (!allowAuto || !rc || !rc.plan.L.textLinks || rc.linksUsed >= rc.plan.L.textLinkMax || /aff:|rel="sponsored/.test(t)) return t;
  // one automatic link per paragraph, first natural mention of an ad keyword, never inside another link
  for (const ad of rc.plan.lib) {
    if (!ad.url || !ad.placements.has('text') || rc.linked.has(ad.id)) continue;
    const phrases = [...ad.kwPhrases.filter(ph => ph.includes(' ')), ...(ad.name && ad.name.length > 3 ? [ad.name.toLowerCase()] : [])];
    for (const ph of phrases) {
      const re = new RegExp(`(^|[^\\w-])(${escRe(esc(ph))})(?=[^\\w-]|$)`, 'i');
      let done = false;
      t = t.split(/(<a\b[^>]*>.*?<\/a>|<[^>]+>)/s).map(seg => {
        if (done || seg.startsWith('<')) return seg;
        return seg.replace(re, (m, pre, word) => { done = true; return `${pre}<a href="${esc(ad.url)}" target="_blank" rel="${AD_REL}">${word}</a>`; });
      }).join('');
      if (done) { rc.linked.add(ad.id); rc.linksUsed++; rc.affiliate = true; return t; }
    }
  }
  return t;
}

const adLabel = o => esc(o.adLabel || 'Sponsored');
function adUnit(ad, kind, o, slotName = '') {
  const slotAttr = slotName ? ` data-slot="${esc(slotName)}"` : '';
  if (!ad) return block('html', `<!-- AURA:AD:${esc(slotName)} --><div class="aura-ad-slot"${slotAttr}></div>`);
  if (ad.html) return block('html', `<div class="aura-ad aura-ad--code aura-ad--${kind}"${slotAttr}>${ad.html}</div>`);
  const url = esc(ad.url), head = esc(ad.label || ad.name || 'Recommended resource'), cta = esc(ad.cta || 'Learn more');
  const a = (inner, extra = '') => `<a href="${url}" target="_blank" rel="${AD_REL}"${extra}>${inner}</a>`;
  const small = `<span style="display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#667085;margin:0 0 6px">${adLabel(o)}</span>`;
  const btn = a(`${cta}`, ` class="aura-ad__cta" style="display:inline-block;padding:9px 16px;border-radius:999px;background:#0d64bc;color:#fff;font-weight:600;font-size:.95em"`);
  if (kind === 'top') return block('html', `<aside class="aura-ad aura-ad--top"${slotAttr} style="margin:1.2em 0 1.6em;padding:12px 16px;border:1px solid #e3e8ef;border-radius:12px;background:#f8fafc;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:.95em">
<span style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#667085">${adLabel(o)}</span>${a(`<strong>${head}</strong>`)}${ad.text ? `<span style="color:#475467">${esc(clip(ad.text, 110))}</span>` : ''}${a(`${cta} →`, ' class="aura-ad__cta" style="font-weight:600;margin-left:auto"')}</aside>`);
  const img = ad.image ? a(`<img src="${esc(ad.image)}" alt="${head}" loading="lazy" style="width:100%;height:auto;border-radius:10px;margin:0 0 10px">`) : '';
  if (kind === 'side') return block('html', `<aside class="aura-ad aura-ad--side"${slotAttr} style="margin:1.5em auto;max-width:420px;padding:16px 18px;border:1px solid #e3e8ef;border-radius:14px;background:#f8fafc;font-size:.95em">
${small}${img}<p style="margin:0 0 6px;font-weight:700;line-height:1.3">${a(head)}</p>${ad.text ? `<p style="margin:0 0 12px;color:#475467">${esc(clip(ad.text, 140))}</p>` : ''}<p style="margin:0">${btn}</p></aside>`);
  return block('html', `<aside class="aura-ad aura-ad--inline"${slotAttr} style="margin:2em 0;padding:18px 20px;border:1px solid #e3e8ef;border-radius:14px;background:#f8fafc">
${small}${img}<p style="margin:0 0 8px;font-size:1.15em;font-weight:700">${a(head)}</p>${ad.text ? `<p style="margin:0 0 14px">${esc(ad.text)}</p>` : ''}<p style="margin:0">${btn}</p></aside>`);
}
function endList(ads, o) {
  return block('html', `<aside class="aura-ad aura-ad--end" style="margin:2.4em 0 1em;padding:16px 0 0;border-top:1px solid #e3e8ef">
<p style="margin:0 0 8px;font-weight:700">Recommended resources</p><ul style="margin:0;padding-left:1.1em">${ads.map(a => `<li style="margin:.35em 0"><a href="${esc(a.url)}" target="_blank" rel="${AD_REL}">${esc(a.label || a.name)}</a>${a.text ? ` — ${esc(clip(a.text, 100))}` : ''}</li>`).join('')}</ul>
<p style="margin:.6em 0 0;font-size:12px;color:#667085">${adLabel(o)} links</p></aside>`);
}

// ---------- page design: every block carries its own inline styles, so it looks finished in any theme ----------
const TONES = { tip: ['#0d64bc', '#eef5fd', '💡'], note: ['#475467', '#f4f6f9', '📌'], warning: ['#b54708', '#fff7ed', '⚠️'], example: ['#067647', '#effaf5', '✍️'] };
const anchorOf = (t, used) => { let a = slug(stripHtml(t)).slice(0, 60) || 'section', b = a, n = 2; while (used.has(b)) b = `${a}-${n++}`; used.add(b); return b; };
const box = (inner, style, cls) => block('html', `<div class="${cls}" style="${style}">${inner}</div>`);

function renderPost(p, media, o = {}) {
  const plan = planAds(p, o), L = plan.L;
  const rc = { plan, linked: new Set(), linksUsed: 0, affiliate: false };
  for (const x of p.sections || []) for (const m of String([x.content, ...(x.items || []).map(it => typeof it === 'object' ? `${it.q} ${it.a}` : it)].join(' ')).matchAll(/\]\(aff:([\w.-]+)\)/g)) { const ad = plan.byId.get(slug(m[1])); if (ad) rc.linked.add(ad.id); }
  const out = [], s = p.sections;
  const stats = { top: 0, side: 0, inline: 0, end: 0, textLinks: 0 };
  const unit = (ad, kind, slot) => { if (ad?.url) rc.affiliate = true; stats[kind === 'side' ? 'side' : kind]++; return adUnit(ad, kind, o, slot); };
  const design = o.design !== false;
  const used = new Set();
  const anchors = new Map(); // section index -> anchor
  s.forEach((x, i) => { if (x.type === 'heading' && x.level === 2) anchors.set(i, anchorOf(x.content, used)); if (x.type === 'faq') anchors.set(i, anchorOf(x.title, used)); });
  const tocItems = [...anchors].map(([i, a]) => ({ a, t: s[i].type === 'faq' ? s[i].title : s[i].content })).filter(x => !/^key takeaways$/i.test(x.t));
  const tocBlock = () => box(`<p style="margin:0 0 10px;font-weight:700;font-size:15px;letter-spacing:.02em">In this article</p><ol style="margin:0;padding-left:1.3em;columns:2 240px;column-gap:28px">${tocItems.map(x => `<li style="margin:.3em 0;break-inside:avoid"><a href="#${x.a}" style="text-decoration:none">${esc(stripHtml(x.t).replace(/\*\*/g, ''))}</a></li>`).join('')}</ol>`,
    'margin:1.6em 0;padding:18px 22px;border:1px solid #e3e8ef;border-radius:14px;background:#fbfcfe;font-size:15px', 'aura-toc');
  let tocDone = !(design && tocItems.length >= 4), topWaiting = false;
  const takeIdx = s.findIndex(x => x.type === 'heading' && TAKEAWAY_RE.test(x.content));
  if (plan.top && plan.topAt === -1) out.push(unit(plan.top, 'top'));
  s.forEach((x, i) => {
    const prev = s[i - 1];
    switch (x.type) {
      case 'heading': {
        const a = anchors.get(i), attrs = a ? { anchor: a, ...(x.level !== 2 ? { level: x.level } : {}) } : (x.level !== 2 ? { level: x.level } : null);
        if (!tocDone && x.level === 2) { out.push(tocBlock()); tocDone = true; if (topWaiting) { out.push(unit(plan.top, 'top')); topWaiting = false; } }
        out.push(block('heading', `<h${x.level} class="wp-block-heading"${a ? ` id="${a}"` : ''}>${inlineRich(x.content, rc, false)}</h${x.level}>`, attrs));
        break;
      }
      case 'intro': out.push(block('paragraph', `<p class="aura-intro" style="font-size:1.15em;line-height:1.65">${inlineRich(x.content, rc, false)}</p>`, { className: 'aura-intro' })); break;
      case 'takeaways': out.push(box(`<p style="margin:0 0 10px;font-weight:700;font-size:1.05em">${esc(x.title)}</p><ul style="margin:0;padding:0;list-style:none">${x.items.map(it => `<li style="margin:.45em 0;padding-left:1.7em;position:relative"><span aria-hidden="true" style="position:absolute;left:0;color:#067647;font-weight:700">✓</span>${inlineRich(it, rc, false)}</li>`).join('')}</ul>`,
        'margin:1.6em 0;padding:20px 22px;border-radius:16px;background:linear-gradient(135deg,#effaf5,#eef5fd);border:1px solid #d5ece1', 'aura-takeaways')); break;
      case 'image': {
        const m = media[lc(x.filename)];
        if (!m) { out.push(`<!-- AURA:MISSING:${esc(x.filename)} -->`); break; }
        const cap = x.caption ? `<figcaption class="wp-element-caption" style="text-align:center;font-size:.9em;color:#667085;margin-top:.6em">${esc(x.caption)}</figcaption>` : '';
        out.push(block('image', `<figure class="wp-block-image size-large${design ? ' is-style-rounded-corners' : ''}" style="margin:2em 0"><img src="${esc(m.source_url)}" alt="${esc(x.alt_text)}" class="wp-image-${m.id}" style="border-radius:14px;box-shadow:0 10px 30px rgba(16,24,40,.12)"/>${cap}</figure>`, { id: m.id, sizeSlug: 'large', linkDestination: 'none' }));
        break;
      }
      case 'ad': { const u = plan.inline.get(i); out.push(unit(u?.ad, u?.kind || 'inline', x.slot)); break; }
      case 'list': { const tag = x.ordered ? 'ol' : 'ul'; out.push(block('list', `<${tag} class="wp-block-list" style="padding-left:1.3em">${x.items.map(it => `<!-- wp:list-item -->\n<li style="margin:.4em 0">${inlineRich(it, rc, false)}</li>\n<!-- /wp:list-item -->`).join('\n')}</${tag}>`, x.ordered ? { ordered: true } : null)); break; }
      case 'checklist': {
        if (x.title && prev?.type !== 'heading') out.push(block('heading', `<h2 class="wp-block-heading">${inlineRich(x.title, rc, false)}</h2>`));
        out.push(block('html', `<ul class="aura-checklist" style="list-style:none;margin:1.2em 0;padding:18px 22px;border:1px solid #e3e8ef;border-radius:16px;background:#fbfcfe">${x.items.map((it, k) => `<li style="margin:${k ? '.7em' : '0'} 0 0;padding:${k ? '.7em' : '0'} 0 0 2.1em;position:relative;${k ? 'border-top:1px dashed #e3e8ef' : ''}"><span aria-hidden="true" style="position:absolute;left:0;top:${k ? '.7em' : '0'};width:1.3em;height:1.3em;border:2px solid #0d64bc;border-radius:5px;display:inline-block"></span>${inlineRich(it, rc, false)}</li>`).join('')}</ul>`));
        break;
      }
      case 'callout': {
        const [c, bg, ic] = TONES[x.tone] || TONES.tip;
        out.push(block('html', `<aside class="aura-callout aura-callout--${x.tone || 'tip'}" style="margin:1.8em 0;padding:16px 20px;border-left:4px solid ${c};background:${bg};border-radius:10px">${x.label ? `<p style="margin:0 0 6px;font-weight:700;color:${c}">${ic} ${esc(x.label)}</p>` : ''}<p style="margin:0">${inlineRich(x.content, rc, false)}</p></aside>`));
        break;
      }
      case 'pullquote': out.push(block('pullquote', `<figure class="wp-block-pullquote" style="margin:2.2em 0;padding:1.4em 1em;border-top:3px solid #0d64bc;border-bottom:3px solid #0d64bc;text-align:center"><blockquote><p style="font-size:1.35em;line-height:1.45;font-style:italic">${inlineRich(x.content, rc, false)}</p>${x.cite ? `<cite style="font-size:.85em;color:#667085">${esc(x.cite)}</cite>` : ''}</blockquote></figure>`)); break;
      case 'faq': {
        const a = anchors.get(i);
        out.push(block('heading', `<h2 class="wp-block-heading" id="${a}">${esc(x.title)}</h2>`, { anchor: a }));
        for (const it of x.items) out.push(block('details', `<details class="wp-block-details" style="margin:.7em 0;padding:14px 18px;border:1px solid #e3e8ef;border-radius:12px;background:#fbfcfe"><summary style="font-weight:600;cursor:pointer">${esc(it.q)}</summary>\n<!-- wp:paragraph -->\n<p style="margin:.7em 0 0">${inlineRich(it.a, rc, false)}</p>\n<!-- /wp:paragraph --></details>`));
        break;
      }
      case 'html': out.push(block('html', x.content)); break;
      default: {
        const closing = takeIdx > -1 && i === takeIdx + 1 && prev?.type === 'heading';
        if (closing && design) out.push(box(`<p style="margin:0;font-size:1.1em;line-height:1.65">${inlineRich(x.content, rc, false)}</p>`, 'margin:1.2em 0 1.8em;padding:22px 24px;border-radius:16px;background:linear-gradient(135deg,#0d64bc,#0a3c8f);color:#fff', 'aura-closing'));
        else out.push(block('paragraph', `<p>${inlineRich(x.content, rc, true)}</p>`));
      }
    }
    if (plan.top && plan.topAt === i) { if (tocDone) out.push(unit(plan.top, 'top')); else topWaiting = true; } // banner sits after the contents box, never between intro and takeaways
    if (plan.side.has(i)) out.push(unit(plan.side.get(i), 'side'));
  });
  // Keep reading: other posts from this queue already live on the site
  const related = (o.related || []).filter(r => r?.link && r.title && r.link !== o.selfLink).slice(0, 3);
  if (design && related.length) out.push(box(`<p style="margin:0 0 10px;font-weight:700">Keep reading</p><ul style="margin:0;padding-left:1.1em">${related.map(r => `<li style="margin:.35em 0"><a href="${esc(r.link)}">${esc(r.title)}</a></li>`).join('')}</ul>`, 'margin:2em 0 1em;padding:18px 22px;border-radius:14px;background:#f4f6f9', 'aura-related'));
  if (plan.end.length) { out.push(endList(plan.end, o)); stats.end = plan.end.length; rc.affiliate = true; }
  stats.textLinks = rc.linksUsed;
  const head = [];
  if (o.css && (stats.side || stats.top)) head.push(block('html', `<style>${AD_CSS}</style>`));
  if (L.disclosure && rc.affiliate) head.push(block('paragraph', `<p class="aura-disclosure" style="font-size:13px;color:#667085;font-style:italic">${esc(L.disclosureText)}</p>`, { className: 'aura-disclosure' }));
  // FAQ rich results (needs a user WordPress lets post <script>, i.e. unfiltered_html)
  const faqs = s.filter(x => x.type === 'faq').flatMap(x => x.items);
  if (o.css && faqs.length) out.push(block('html', `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(f => ({ '@type': 'Question', name: stripHtml(f.q), acceptedAnswer: { '@type': 'Answer', text: stripHtml(f.a).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '') } })) }).replace(/</g, '\\u003c')}</script>`));
  const html = [...head, ...out].join('\n\n');
  if (o.withStats) return { html, stats };
  return html;
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
  if (meta.description) patch.description = meta.description;
  if (Object.keys(patch).length) await wpFetch(w, `media/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
}
async function uploadMedia(w, file, meta) {
  const name = asciiName(file.originalname);
  const r = await wpFetch(w, 'media', { method: 'POST', timeout: 120000, headers: { 'Content-Type': mimeFor(name), 'Content-Disposition': `attachment; filename="${name}"` }, body: file.buffer });
  await setMediaMeta(w, r.id, meta);
  return { id: r.id, source_url: r.source_url };
}

// ---------- routes ----------
const healthBody = () => ({ ok: true, status: 'online', service: 'Aura Publisher Pro API', version: API_VERSION, protocol: PROTOCOL, features: { templateStudio: true, wordpressBridge: true, resourceUploads: true, imageGeneration: !!process.env.OPENAI_API_KEY, imageModel: IMAGE_MODEL, standard: 'Mindful Adaption Standard', statuses: ['draft', 'publish', 'future', 'pending', 'private'], adPlacement: ['top', 'side', 'inline', 'text', 'end'], visualEngine: true, coverStyles: ['full', 'title', 'photo'], seoAudit: true } });
app.get('/', (q, r) => r.type('html').send(`<h1>Aura Publisher Pro API</h1><p>Online — V16 (API ${API_VERSION})</p>`));
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


// ---------- V15 Site Studio: WordPress Bridge + full template publishing ----------
app.post('/api/wp/structure', async (req, res) => {
  try {
    const w = req.body.wordpress || {};
    const d = await discoverWp(w), creds = { ...w, url: d.site, restRoot: d.root };
    const me = await wpFetch(creds, 'users/me?context=edit&_fields=id,name,roles,capabilities');
    const [categories, pages, posts] = await Promise.all([
      wpFetch(creds, 'categories?per_page=100&orderby=name&order=asc&_fields=id,name,slug,parent,count,description').catch(() => []),
      wpFetch(creds, 'pages?per_page=100&status=publish,draft,pending,private&orderby=title&order=asc&context=edit&_fields=id,title,slug,status,link').catch(() => []),
      wpFetch(creds, 'posts?per_page=50&status=publish,draft,pending,private&orderby=modified&order=desc&context=edit&_fields=id,title,slug,status,link').catch(() => [])
    ]);
    let bridge = null;
    try { bridge = await wpFetchNs(creds, 'aura/v1', 'ping'); } catch { try { bridge = await wpFetchNs(creds, 'aura/v1', 'status'); } catch {} }
    res.json({ ok: true, site: d.site, user: { id: me.id, name: me.name, roles: me.roles || [] }, capabilities: me.capabilities || {}, categories, pages, posts,
      bridge: bridge ? { installed: true, ...bridge } : { installed: false },
      support: bridge?.capabilities?.category_takeover
        ? { categoryDescription: true, fullArchiveReplacement: true, affiliateSidebar: true, note: 'Aura Site Bridge is active. Category templates can fully control the archive while preserving your WordPress header, footer and live post data.' }
        : { categoryDescription: true, fullArchiveReplacement: false, affiliateSidebar: false, note: 'Install Aura Site Bridge to make category templates fully control the archive. Core WordPress alone strips or relocates template CSS from category descriptions.' }
    });
  } catch (e) { res.status(400).json(wpError(e)); }
});

app.post('/api/wp/bridge/status', async (req, res) => {
  try {
    const w=req.body.wordpress||{}; const d=await discoverWp(w), creds={...w,url:d.site,restRoot:d.root};
    let status; try{status=await wpFetchNs(creds,'aura/v1','ping');}catch{status=await wpFetchNs(creds,'aura/v1','status');}
    let diagnostics=null; try{diagnostics=await wpFetchNs(creds,'aura/v1','diagnostics')}catch{}
    res.json({ok:true,status,diagnostics});
  } catch(e){ const o=wpError(e); if(e.status===404 || e.wpCode==='rest_no_route') return res.status(404).json({error:'Aura Site Bridge is not installed or not active.',code:'bridge_missing'}); res.status(400).json(o); }
});

app.post('/api/wp/template/publish', async (req, res) => {
  try {
    const w = req.body.wordpress || {}, t = req.body.template || {};
    if (!w.url || !w.username || !w.appPassword) return res.status(400).json({ error: 'Connect WordPress first.' });
    const d = await discoverWp(w), creds = { ...w, url: d.site, restRoot: d.root };
    const me = await wpFetch(creds, 'users/me?context=edit&_fields=id,capabilities');
    const type = ['category','page','resource','post'].includes(t.destination) ? t.destination : 'page';
    const status = ['draft','publish','pending','private'].includes(t.status) ? t.status : 'draft';
    if (['publish','private'].includes(status) && me.capabilities && !me.capabilities.publish_posts && type !== 'category') return res.status(403).json({ error: 'This WordPress user cannot publish live content.' });

    if (type === 'category') {
      const id = Number(t.targetId); if (!id) return res.status(422).json({ error: 'Choose a WordPress category.' });
      try {
        const payload = {
          name:t.name||'', eyebrow:t.eyebrow||'', title:t.title||t.name||'', intro:t.intro||'', hero:t.hero||'', accent:t.accent||'#2378d2', variant:t.variant||'editorial', mode:t.archiveMode||'full',
          blocks:Array.isArray(t.blocks)?t.blocks:[], affiliates:Array.isArray(t.affiliates)?t.affiliates:[], showNativePosts:t.showNativePosts!==false, contentWidth:t.contentWidth||'1180', density:t.density||'balanced', radius:t.radius||'20', fontPair:t.fontPair||'modern', seo:t.seo||{}
        };
        const out = await wpFetchNs(creds,'aura/v1',`category/${id}/template`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        return res.json({ok:true,destination:'category',id,link:out.link,status:'updated',bridge:true,note:'Full category template published through Aura Site Bridge. Styles stay in the plugin, so WordPress cannot print them as raw text.'});
      } catch(e) {
        if(e.status===404 || e.wpCode==='rest_no_route') return res.status(409).json({error:'Install and activate Aura Site Bridge before publishing a category takeover. This prevents WordPress from exposing CSS as text and enables the full archive layout.',code:'bridge_required'});
        throw e;
      }
    }

    const html = String(t.html || '').trim(); if (!html) return res.status(422).json({ error: 'Template content is empty.' });
    const endpoint = type === 'page' ? 'pages' : 'posts';
    let target = Number(t.targetId) || null; const title = String(t.title || t.name || 'Aura Template').trim(); const wantedSlug = slug(t.slug || title);
    if (!target && wantedSlug) { const found = await wpFetch(creds, `${endpoint}?slug=${encodeURIComponent(wantedSlug)}&status=publish,draft,pending,private&context=edit&_fields=id`); if (Array.isArray(found) && found[0]) target = found[0].id; }
    const body = { title, slug: wantedSlug, content: html, status, excerpt: String(t.excerpt || '').slice(0, 500) };
    if (endpoint === 'posts') { let catId = Number(t.categoryId) || 0; if (!catId && type === 'resource') catId = await termId(creds, 'categories', 'Resources', new Map()); if (catId) body.categories = [catId]; }
    const out = await wpFetch(creds, target ? `${endpoint}/${target}` : endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let seoApplied=false; if(t.seo && Object.values(t.seo).some(Boolean)){ try{await wpFetchNs(creds,'aura/v1',`post/${out.id}/seo`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(t.seo)});seoApplied=true;}catch{} }
    res.json({ ok: true, destination: type, id: out.id, link: out.link, status: out.status, updated: !!target, seoApplied });
  } catch (e) { const o = wpError(e); res.status(o.status === 401 ? 401 : (e.status||400)).json(o); }
});

app.post('/api/wp/resource/upload', upload.single('file'), async (req, res) => {
  try {
    const w = readJson(req.body.wordpress), meta = readJson(req.body.meta);
    if (!req.file) return res.status(422).json({ error: 'Choose a resource file.' });
    const d = await discoverWp(w), creds = { ...w, url: d.site, restRoot: d.root };
    const name = asciiName(req.file.originalname);
    const media = await wpFetch(creds, 'media', { method: 'POST', timeout: 120000, headers: { 'Content-Type': req.file.mimetype || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` }, body: req.file.buffer });
    const title = String(meta.title || name.replace(/\.[^.]+$/, '')).trim();
    const description = String(meta.description || '').trim();
    const catId = Number(meta.categoryId) || await termId(creds, 'categories', 'Resources', new Map());
    const html = `<div class="aura-resource-shell"><section class="aura-resource-hero"><span>FREE RESOURCE</span><h1>${esc(title)}</h1><p>${esc(description || 'A free Mindful Adaption resource designed to make the next step simpler.')}</p><a class="aura-resource-download" href="${esc(media.source_url)}" download>Download free resource →</a></section><section class="aura-resource-trust"><b>Made for real life</b><p>Save it, print it or keep it on your device and use it at your own pace.</p><small>File: ${esc(name)}</small></section></div>`;
    const post = await wpFetch(creds, 'posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, slug: slug(title), content: html, excerpt: description.slice(0, 400), status: ['publish','draft','pending','private'].includes(meta.status) ? meta.status : 'draft', categories: catId ? [catId] : [] }) });
    res.json({ ok: true, media: { id: media.id, url: media.source_url, name }, post: { id: post.id, link: post.link, status: post.status } });
  } catch (e) { const o = wpError(e); res.status(o.status === 401 ? 401 : 400).json(o); }
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
    const rejected = [];
    if (options.rejectPlaceholders !== false) for (const [k, a] of assetMap) if (looksPlaceholder(a.buffer)) { rejected.push(a.name); assetMap.delete(k); }
    const matchedByOrder = assignLooseImages(rawPosts, assetMap, options.existingAssets || []);
    const extra = Array.isArray(options.existingAssets) ? options.existingAssets : [];
    const names = [...assetMap.values()].map(a => a.name);
    const posts = preparePosts(rawPosts, [...names, ...extra], options);
    res.json({
      protocolVersion: PROTOCOL, manifestSource, posts, rejectedImages: rejected, matchedByOrder,
      assets: [...assetMap.values()].map(a => ({ name: a.name, mime: a.mime, size: a.buffer.length, dataBase64: a.buffer.toString('base64') })),
      summary: { posts: posts.length, assets: names.length, ready: posts.filter(p => p.validation.ok).length, rejectedImages: rejected.length, invalid: posts.filter(p => !p.validation.ok).length, pendingImages: posts.reduce((t, p) => t + p.validation.pendingImages.length, 0) }
    });
  } catch (e) { res.status(400).json({ error: `Import failed: ${e.message}` }); }
});

// Re-apply the standard after settings change (no files involved).
app.post('/api/standardize', (req, res) => {
  try {
    const { posts = [], options = {}, assetNames = [] } = req.body || {};
    const all = new Set(Array.isArray(options.usedSignatures) ? options.usedSignatures.slice(-2000) : []);
    const out = posts.slice(0, 500).map(p => {
      const base = normalizePost(p.source || p);
      const own = [p.featured_image, ...(p.sections || [])].map(x => x?.sig).filter(Boolean);
      own.forEach(x => all.delete(x)); // a post may keep its own earlier choices
      const s = applyStandard(base, { ...options, assetNames, heroText: options.heroText !== false, usedSigs: all });
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
  const fullPrompt = `${prompt}\n\nOverall visual style: ${style || 'Photorealistic editorial photography, natural light, authentic real people and settings, shallow depth of field, warm and hopeful mood.'}${/Realism requirements|Premium blog cover|spelled exactly/.test(prompt) ? '' : '\nStrict rules: photorealistic, no text, no letters, no captions, no watermarks, no logos, no brand names, no UI screenshots, realistic hands and faces.'}`.slice(0, 30000);
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

// Exact WordPress HTML for the in-app preview (images point at aura-asset:<filename>).
app.post('/api/preview', (req, res) => {
  try {
    const { post = {}, options = {} } = req.body || {};
    const p = normalizePost(post);
    p.standard = post.standard;
    const media = Object.fromEntries(imageList(p).map(i => [lc(i.filename), { id: 0, source_url: `aura-asset:${i.filename}` }]));
    const r = renderPost(p, media, { ...options, css: true, withStats: true });
    res.json({ ok: true, html: r.html, placements: r.stats });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/ad-css', (q, r) => r.type('text/css').send(AD_CSS));

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
    const me = await wpFetch(creds, 'users/me?context=edit&_fields=id,capabilities').catch(() => ({}));
    o.css = !!me.capabilities?.unfiltered_html; // side-card CSS only when WordPress keeps <style>
    if (['publish', 'future', 'private'].includes(status)) {
      if (me.capabilities && !me.capabilities.publish_posts) return res.status(403).json({ error: 'This WordPress user can only save drafts (the role lacks publish_posts). Use an Author/Editor/Administrator account, or choose "Pending review".', code: 'cannot_publish' });
    }

    // Media: reuse verified uploads from earlier publishes, upload the rest.
    const media = {}; let uploaded = 0, reused = 0;
    for (const img of imageList(p)) {
      const k = lc(img.filename);
      if (media[k]) continue;
      const meta = { alt: img.alt_text, caption: img.caption, title: clip(img.featured ? `${p.title} — featured image` : (img.alt_text || p.title), 90), description: clip(`${img.alt_text}. From the article "${p.title}".`, 300) };
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
    const rendered = renderPost(p, media, { ...o, selfLink: o.selfLink || '', withStats: true });
    const body = { title: p.title, slug: p.slug, excerpt: p.excerpt, content: rendered.html, status, categories: cats, tags, featured_media: featured };
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
    let seoMeta = 'skipped';
    if (p.meta_title || p.meta_description || p.focus_keyphrase) {
      const meta = { rank_math_title: p.meta_title, rank_math_description: p.meta_description, rank_math_focus_keyword: p.focus_keyphrase, _yoast_wpseo_title: p.meta_title, _yoast_wpseo_metadesc: p.meta_description, _yoast_wpseo_focuskw: p.focus_keyphrase };
      try { await wpFetch(creds, `posts/${out.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meta }) }); seoMeta = 'sent'; } catch { seoMeta = 'not supported by this site'; }
    }
    res.json({ ok: true, id: out.id, link: out.link, status: out.status, updated: !!target, seoMeta, uploadedImages: uploaded, reusedImages: reused, placements: rendered.stats, sideCss: o.css,
      media: Object.fromEntries(imageList(p).map(i => [i.filename, media[lc(i.filename)]]).filter(([, m]) => m)) });
  } catch (e) { const o = wpError(e); res.status(o.status === 401 ? 401 : 400).json(o); }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.path }));
app.use((e, q, r, n) => r.status(e.status === 413 || e.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: e.message }));

export { normalizePost, applyStandard, validate, renderPost, planAds, artDirect };
if (process.env.AURA_NO_LISTEN !== '1') app.listen(PORT, '0.0.0.0', () => console.log(`Aura V16 (API ${API_VERSION}) listening on ${PORT}`));
