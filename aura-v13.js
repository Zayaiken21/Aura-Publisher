// Aura Publisher Pro — client V13
(() => {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const API = (window.AURA_CONFIG?.API_BASE || 'https://aura-publisher.onrender.com').replace(/\/$/, '');
  const V = window.AuraVault;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lc = n => String(n || '').replace(/\\/g, '/').split('/').pop().trim().toLowerCase();
  const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

  const DEFAULTS = {
    wp: { url: '', username: '', appPassword: '' }, openaiKey: '',
    standard: { enforce: true, autoGenerate: true, quality: 'high', imagesPerMinute: 4, coverStyle: 'full', heroText: true, rejectPlaceholders: true, altTemplate: '{subject|caption|section|title}, illustrating {keyword}',
      style: 'Vibrant, richly detailed editorial lifestyle photography: real people sharing genuine moments, warm natural sunlight, abundant layered scenes, true-to-life colour, magazine-cover quality.' },
    ads: [], adLabel: 'Sponsored',
    adLayout: { top: true, topPosition: 'after-intro', side: true, sideMax: 2, textLinks: true, textLinkMax: 3, end: true, endMax: 3, disclosure: true, disclosureText: 'This post contains affiliate links. If you buy through them, we may earn a small commission at no extra cost to you.', wordsPerAd: 350 },
    publish: { status: 'publish', mode: 'upsert', gapDays: 0 },
    prompt: { siteName: '', niche: '', audience: '', voice: '', topics: '', extra: '', count: 5, batchSize: 2, batch: 0 },
    autoLockMin: 30
  };
  const merge = (a, b) => { const o = structuredClone(a); for (const k in b || {}) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k]; return o; };

  let S = null;            // decrypted settings for the unlocked user
  let uid = null;          // current user id
  let ws = { posts: [], templates: [], schemaVersion: 14 };
  let health = { online: false, features: {} };
  let busy = false;

  // ---------- UI helpers ----------
  function toast(msg, type = 'info', ms = 4200) { const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), ms); }
  function log(msg, type = '') { const li = document.createElement('li'); li.className = type; li.textContent = `${new Date().toLocaleTimeString()} — ${msg}`; $('#log').prepend(li); while ($('#log').children.length > 200) $('#log').lastChild.remove(); }
  function progress(done, total, label) { const p = $('#progress'); if (total == null) { p.hidden = true; return; } p.hidden = false; p.querySelector('i').style.width = `${Math.round(done / Math.max(1, total) * 100)}%`; p.querySelector('span').textContent = label; }
  function meter(input, bar, hint, userSel) {
    const f = () => { const st = V.strength(input.value, userSel ? $(userSel).value : (V.current()?.username || '')); bar.style.width = `${(st.score + (input.value ? 1 : 0)) * 20}%`; bar.dataset.s = st.ok ? 'ok' : st.score >= 2 ? 'mid' : 'low'; hint.textContent = input.value ? (st.ok ? 'Strong password.' : 'Needs ' + st.issues.join(', ') + '.') : '12+ characters with 3 of: lowercase, uppercase, number, symbol.'; };
    input.addEventListener('input', f); f();
  }
  $$('.eye').forEach(b => b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? 'Show' : 'Hide'; });

  // ---------- API ----------
  async function api(path, opt = {}, retries = 2) {
    let r;
    try { r = await fetch(API + path, { ...opt, mode: 'cors', cache: 'no-store' }); }
    catch { throw new Error('Could not reach Aura Engine. It may be waking up; try again in 30 seconds.'); }
    const t = await r.text(); let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { error: t || 'Invalid server response' }; }
    if (r.status === 429 && retries > 0) { const wait = (Number(r.headers.get('retry-after')) || 20) * 1000; log(`Rate limited, waiting ${Math.round(wait / 1000)} s…`, 'warn'); await sleep(Math.min(wait, 65000)); return api(path, opt, retries - 1); }
    if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status, body: j });
    return j;
  }
  const canGenerate = () => !!(health.features?.imageGeneration || S?.openaiKey);
  const stdOptions = () => ({ enforce: S.standard.enforce, canGenerate: canGenerate(), altTemplate: S.standard.altTemplate, heroText: S.standard.coverStyle !== 'photo', coverStyle: S.standard.coverStyle || 'full', rejectPlaceholders: S.standard.rejectPlaceholders !== false, usedSignatures: (ws.sigs || []).slice(-1500) });
  // Remember every photo "signature" (setting + shot + time) so new posts never repeat an earlier image.
  function rememberSigs(posts) {
    const all = new Set(ws.sigs || []);
    for (const p of posts) for (const i of images(p)) if (i.sig) all.add(i.sig);
    ws.sigs = [...all].slice(-2000);
  }

  // ---------- per-user image store (IndexedDB) ----------
  const dbp = new Promise((res, rej) => { const q = indexedDB.open('aura-assets-v11', 1); q.onupgradeneeded = () => { const d = q.result; if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'key' }); }; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const akey = n => `${uid}::${lc(n)}`;
  const tx = async (mode, fn) => { const d = await dbp; return new Promise((res, rej) => { const t = d.transaction('assets', mode), st = t.objectStore('assets'); let out; const r = fn(st); if (r) r.onsuccess = () => { out = r.result; }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Storage aborted')); }); };
  const assetPut = a => tx('readwrite', st => st.put({ key: akey(a.name), name: String(a.name).split('/').pop(), mime: a.mime, dataBase64: a.dataBase64, size: a.size || 0 }));
  const assetGet = n => tx('readonly', st => st.get(akey(n))).then(x => x || null);
  const assetDel = n => tx('readwrite', st => st.delete(akey(n)));
  const assetKeys = () => tx('readonly', st => st.getAllKeys(IDBKeyRange.bound(`${uid}::`, `${uid}::\uffff`))).then(k => (k || []).map(x => x.split('::').slice(1).join('::')));
  const assetClearUser = u => tx('readwrite', st => st.delete(IDBKeyRange.bound(`${u}::`, `${u}::\uffff`)));
  const b64blob = a => { const bin = atob(a.dataBase64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: a.mime || 'image/jpeg' }); };

  // ---------- workspace (IndexedDB; avoids localStorage's small ~5 MB quota) ----------
  const wsKey = () => `aura-ws:${uid}`;
  const wsdbp = new Promise((res, rej) => {
    const q = indexedDB.open('aura-workspaces-v13', 1);
    q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains('workspaces')) q.result.createObjectStore('workspaces', { keyPath: 'key' }); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const wsTx = async (mode, fn) => { const d = await wsdbp; return new Promise((res, rej) => { const t=d.transaction('workspaces',mode), st=t.objectStore('workspaces'); let out; const r=fn(st); if(r) r.onsuccess=()=>{out=r.result}; t.oncomplete=()=>res(out); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error||new Error('Workspace storage aborted')); }); };
  async function loadWs() {
    const key = wsKey(); let rec = await wsTx('readonly', st => st.get(key)).catch(() => null);
    if (!rec) {
      // One-time migration from older Aura versions.
      try { const legacy = JSON.parse(localStorage.getItem(key) || 'null'); if (legacy?.posts) { ws = { templates: [], ...legacy, schemaVersion: 14 }; await wsTx('readwrite', st => st.put({ key, value: ws })); localStorage.removeItem(key); return; } } catch {}
    }
    ws = rec?.value?.posts ? { templates: [], ...rec.value, schemaVersion: 14 } : { posts: [], templates: [], schemaVersion: 14 };
  }
  async function saveWs() {
    if (!uid) return;
    try { await wsTx('readwrite', st => st.put({ key: wsKey(), value: ws })); }
    catch (e) { toast('Aura could not save the queue. Try clearing old site data or exporting the queue.', 'bad', 9000); throw e; }
  }
  const deleteWs = u => wsTx('readwrite', st => st.delete(`aura-ws:${u}`));
  const images = p => [...(p.featured_image?.filename ? [{ ...p.featured_image, featured: true }] : []), ...(p.sections || []).filter(s => s.type === 'image' && s.filename)];
  async function refreshPending() {
    const have = new Set((await assetKeys()).map(lc));
    for (const p of ws.posts) {
      const wpMedia = new Set(Object.keys(p.wp?.media || {}).map(lc));
      const pend = images(p).filter(i => !have.has(lc(i.filename)) && !wpMedia.has(lc(i.filename))).map(i => i.filename);
      p.pending = pend;
      const hard = (p.validation?.errors || []).filter(e => !/^Missing image:/.test(e));
      const missingErr = canGenerate() ? [] : pend.map(f => `Missing image: ${f} (add it to the ZIP or turn on image generation)`);
      p.validation = { ...(p.validation || {}), errors: [...hard, ...missingErr], ok: !hard.length && !missingErr.length };
    }
    saveWs();
  }

  // ---------- render queue ----------
  const statusLabel = { publish: 'Published', future: 'Scheduled', draft: 'Draft', pending: 'Pending review', private: 'Private' };
  function render() {
    const ps = ws.posts; updateDetails();
    $('#sTotal').textContent = ps.length;
    $('#sReady').textContent = ps.filter(p => p.validation?.ok).length;
    $('#sPending').textContent = ps.reduce((t, p) => t + (p.pending?.length || 0), 0);
    $('#sLive').textContent = ps.filter(p => p.wp?.id).length;
    if (!ps.length) { $('#list').innerHTML = `<div class="empty"><p>No posts in the queue.</p><button class="primary" data-go="prompt">Get the ChatGPT prompt</button> <button data-go="import">Import a package</button></div>`; return; }
    $('#list').innerHTML = ps.map((p, i) => {
      const st = p.standard?.stats || {}, v = p.validation || {};
      const badges = [
        v.ok ? `<span class="b ok">Ready</span>` : `<span class="b bad">Needs fixes</span>`,
        p.pending?.length ? `<span class="b warn">${p.pending.filter(f => inflight.has(f)).length ? 'Creating photos…' : `${p.pending.length} photo${p.pending.length > 1 ? 's' : ''} to create`}</span>` : `<span class="b ok">Photos ready</span>`,
        p.seo ? `<span class="b ${p.seo.score >= 80 ? 'ok' : p.seo.score >= 60 ? 'warn' : 'bad'}">SEO ${p.seo.score}</span>` : '',
        p.wp?.id ? `<a class="b live" href="${esc(p.wp.link)}" target="_blank" rel="noopener">${esc(statusLabel[p.wp.status] || p.wp.status)} · #${p.wp.id}</a>` : ''
      ].join('');
      const meta = [st.words ? `${st.words.toLocaleString()} words · ${st.minutes} min read` : '', p.format_variant, `${st.images ?? images(p).length} images`, `${st.ads ?? 0} ads`].filter(Boolean).join(' · ');
      const issues = [...(v.errors || []).map(e => `<li class="bad">${esc(e)}</li>`), ...(p.seo?.checks || []).filter(c => !c.ok).map(c => `<li class="warn">SEO: ${esc(c.label)}</li>`), ...(v.warnings || []).map(e => `<li class="warn">${esc(e)}</li>`), ...(p.standard?.notes || []).map(e => `<li>${esc(e)}</li>`)].join('');
      const tgt = p.target?.status || '';
      return `<article class="card" data-i="${i}">
        <div class="card-main">
          <h3>${esc(p.title || 'Untitled post')}</h3>
          <p class="meta">${esc(meta)}</p>
          <div class="badges">${badges}</div>
          ${issues ? `<details class="issues"><summary>${(v.errors || []).length} errors · ${(v.warnings || []).length} warnings · ${(p.seo?.checks || []).filter(c => !c.ok).length} SEO tips · ${(p.standard?.notes || []).length} auto-fixes</summary><ul>${issues}</ul></details>` : ''}
        </div>
        <div class="card-act">
          <select data-act="status" aria-label="Publish status for this post">
            <option value="" ${!tgt ? 'selected' : ''}>Use queue setting</option>
            ${['publish', 'future', 'pending', 'draft', 'private'].map(s => `<option value="${s}" ${tgt === s ? 'selected' : ''}>${{ publish: 'Publish now', future: 'Schedule', pending: 'Pending review', draft: 'Draft', private: 'Private' }[s]}</option>`).join('')}
          </select>
          ${tgt === 'future' ? `<input type="datetime-local" data-act="date" value="${esc(p.target?.date || '')}" aria-label="Schedule date">` : ''}
          <div class="btns">
            <button data-act="preview">Preview</button>
            <button data-act="photos" class="ghost" title="Use your own photos for this post">Own photos</button>
            ${p.pending?.length ? `<button data-act="gen" ${canGenerate() ? '' : 'disabled title="Image generation is not configured"'}>Generate images</button>` : ''}
            <button class="primary" data-act="publish" ${v.ok ? '' : 'disabled'}>${p.wp?.id ? 'Update' : 'Publish'}</button>
            <button class="ghost danger x" data-act="remove" aria-label="Remove ${esc(p.title)}">×</button>
          </div>
        </div>
      </article>`;
    }).join('');
  }
  $('#list').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const i = Number(b.closest('.card').dataset.i), p = ws.posts[i]; if (!p) return;
    if (b.dataset.act === 'preview') return preview(p);
    if (b.dataset.act === 'photos') { pickPhotosFor = [p.post_id]; $('#photoFiles').click(); return; }
    if (b.dataset.act === 'remove') return removePost(i);
    if (busy) return toast('Another job is running. Wait for it to finish.', 'warn');
    busy = true; b.disabled = true;
    try {
      if (b.dataset.act === 'gen') await generateFor(p);
      if (b.dataset.act === 'publish') { if (confirm(`${p.wp?.id ? 'Update' : 'Send'} "${p.title}" to WordPress as ${describe(targetFor(p, 0))}?`)) await publish(p, 0); }
    } catch (err) { toast(err.message, 'bad', 8000); log(err.message, 'bad'); }
    finally { busy = false; render(); }
  });
  $('#list').addEventListener('change', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const p = ws.posts[Number(el.closest('.card').dataset.i)];
    p.target = p.target || {};
    if (el.dataset.act === 'status') { p.target.status = el.value; if (el.value === 'future' && !p.target.date) p.target.date = defaultFuture(); }
    if (el.dataset.act === 'date') p.target.date = el.value;
    saveWs(); render();
  });
  async function removePost(i) {
    const p = ws.posts[i]; if (!confirm(`Remove "${p.title}" from the queue? It stays on WordPress if already published.`)) return;
    ws.posts.splice(i, 1);
    const still = new Set(ws.posts.flatMap(x => images(x).map(m => lc(m.filename))));
    for (const m of images(p)) if (!still.has(lc(m.filename))) await assetDel(m.filename).catch(() => {});
    saveWs(); render();
  }

  // ---------- targets / scheduling ----------
  const pad = n => String(n).padStart(2, '0');
  const localIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const defaultFuture = () => { const d = new Date(Date.now() + 86400000); d.setHours(9, 0, 0, 0); return localIso(d); };
  function targetFor(p, n) {
    if (p.target?.status) return { status: p.target.status, date: p.target.status === 'future' ? p.target.date : '' };
    const status = $('#bulkStatus').value;
    if (status !== 'future') return { status, date: '' };
    const base = new Date($('#bulkDate').value || defaultFuture());
    base.setDate(base.getDate() + n * Number($('#bulkGap').value || 0));
    return { status, date: localIso(base) + ':00' };
  }
  const describe = t => t.status === 'future' ? `scheduled for ${new Date(t.date).toLocaleString()}` : ({ publish: 'a live post', pending: 'pending review', draft: 'a draft', private: 'a private post' }[t.status]);
  $('#bulkStatus').onchange = () => { const f = $('#bulkStatus').value === 'future'; $('#bulkDateWrap').hidden = $('#bulkGapWrap').hidden = !f; if (f && !$('#bulkDate').value) $('#bulkDate').value = defaultFuture(); S.publish.status = $('#bulkStatus').value; V.save(S).catch(() => {}); };
  $('#bulkGap').onchange = () => { S.publish.gapDays = Number($('#bulkGap').value); V.save(S).catch(() => {}); };

  // ---------- image generation ----------
  // ---------- photos: one image at a time, paced under your per-minute limit, shared by the background worker and publishing ----------
  let lastImageAt = 0, imgChain = Promise.resolve();
  const inflight = new Set();
  const lockImg = fn => { const run = imgChain.then(fn, fn); imgChain = run.catch(() => {}); return run; };
  async function generateOne(p, img) {
    return lockImg(async () => {
      if (!S || (await assetGet(img.filename))) return false; // made meanwhile, or signed out
      inflight.add(img.filename);
      try {
        const gap = 60000 / Math.max(1, Number(S.standard.imagesPerMinute) || 4);
        const wait = lastImageAt + gap - Date.now();
        if (wait > 0) { photoStatus(`Next photo in ${Math.ceil(wait / 1000)} s (staying under ${S.standard.imagesPerMinute || 4} per minute)`); await sleep(wait); }
        lastImageAt = Date.now();
        photoStatus(`Creating ${img.featured ? 'cover' : 'photo'} for "${p.title}"…`);
        log(`Generating ${img.filename}`);
        const j = await api('/api/images/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: img.render_prompt || img.prompt || `${p.title}. ${img.alt_text}`, filename: img.filename, style: S.standard.style, quality: img.featured ? 'high' : S.standard.quality, openaiKey: S.openaiKey || undefined }) }, 4);
        await assetPut({ name: img.filename, mime: j.mime, dataBase64: j.dataBase64, size: j.dataBase64.length * 0.75 });
        log(`Created ${img.filename}`, 'ok');
        return true;
      } finally { inflight.delete(img.filename); }
    });
  }
  async function generateFor(p) {
    if (!canGenerate()) throw new Error('Image generation is not configured. Add OPENAI_API_KEY on Render or your own key in Connections.');
    await refreshPending();
    const todo = images(p).map((i, k) => ({ ...i, featured: k === 0 && !!p.featured_image })).filter(i => p.pending.includes(i.filename));
    for (const img of todo) await generateOne(p, img);
    await refreshPending(); render();
  }
  // Background worker: after an import (or when you come back), every missing photo is created in queue order.
  const worker = { on: false, paused: false, done: 0, total: 0, error: '' };
  function photoStatus(msg) { const el = $('#photoRun'); if (!el) return; el.hidden = !worker.on && !worker.error; $('#photoRunMsg').textContent = msg; $('#photoRunBar').style.width = `${worker.total ? Math.round(worker.done / worker.total * 100) : 0}%`; $('#photoRunCount').textContent = worker.total ? `${worker.done} of ${worker.total} photos` : ''; $('#photoPause').textContent = worker.paused ? 'Resume' : 'Pause'; }
  async function startPhotoWorker() {
    if (worker.on || !S || !canGenerate() || S.standard.autoGenerate === false) return;
    await refreshPending();
    const jobs = ws.posts.flatMap(p => images(p).map((i, k) => ({ p, img: { ...i, featured: k === 0 && !!p.featured_image } })).filter(x => p.pending?.includes(x.img.filename)));
    if (!jobs.length) return;
    Object.assign(worker, { on: true, paused: false, done: 0, total: jobs.length, error: '' });
    photoStatus('Starting photos…');
    for (const { p, img } of jobs) {
      while (worker.paused && S) await sleep(500);
      if (!S || !worker.on) break;
      if (!ws.posts.includes(p)) { worker.done++; continue; }
      try { await generateOne(p, img); worker.done++; await refreshPending(); render(); }
      catch (e) {
        worker.error = e.message; log(`Photo paused: ${e.message}`, 'bad');
        if (/quota|billing|not configured|key/i.test(e.message)) { worker.paused = true; photoStatus(`Paused — ${e.message}`); toast(`Photos paused: ${e.message}`, 'bad', 9000); while (worker.paused && S) await sleep(1000); }
        else await sleep(20000); // temporary problem: wait, then carry on with the next photo
      }
      photoStatus(worker.paused ? 'Paused' : `${worker.done} of ${worker.total} done`);
    }
    worker.on = false; photoStatus(''); if ($('#photoRun')) $('#photoRun').hidden = true;
    if (S) { await refreshPending(); render(); const left = ws.posts.reduce((t, p) => t + (p.pending?.length || 0), 0); if (!left && worker.total) toast(`All ${worker.total} photos are ready.`, 'ok', 6000); else if (left) setTimeout(startPhotoWorker, 1000); }
  }

  // ---------- publishing ----------
  async function publish(p, n) {
    if (!hasWp()) { switchTab('settings'); throw new Error('Add your WordPress connection in Connections before publishing. Everything else works without it.'); }
    await refreshPending();
    if (p.pending?.length) {
      if (canGenerate() && S.standard.autoGenerate) await generateFor(p);
      else throw new Error(`"${p.title}" has ${p.pending.length} image(s) missing. Generate them first.`);
    }
    if (!p.validation?.ok) throw new Error(`"${p.title}" is not ready: ${(p.validation?.errors || []).join('; ')}`);
    const t = targetFor(p, n);
    if (t.status === 'future' && (!t.date || new Date(t.date) <= new Date())) throw new Error('Pick a schedule time in the future.');
    const fd = new FormData();
    fd.append('wordpress', JSON.stringify(S.wp));
    const { source, validation, pending, wp, target, standard, ...post } = p;
    fd.append('post', JSON.stringify(post));
    const cats = new Set((p.categories || []).map(x => x.toLowerCase()));
    const related = ws.posts.filter(x => x !== p && x.wp?.link && ['publish'].includes(x.wp.status)).sort((a, b) => ((b.categories || []).some(c => cats.has(c.toLowerCase())) - (a.categories || []).some(c => cats.has(c.toLowerCase()))) || (b.wp.at || 0) - (a.wp.at || 0)).slice(0, 3).map(x => ({ title: x.title, link: x.wp.link }));
    fd.append('options', JSON.stringify({ related, selfLink: wp?.link || '', status: t.status, date: t.date, mode: S.publish.mode, ads: S.ads, adLabel: S.adLabel, adLayout: S.adLayout, existingMedia: wp?.media || {}, wpPostId: wp?.id || null }));
    const reuse = new Set(Object.keys(wp?.media || {}).map(lc));
    for (const img of images(p)) {
      if (reuse.has(lc(img.filename))) continue;
      const a = await assetGet(img.filename);
      if (!a) throw new Error(`Image ${img.filename} is not stored on this device.`);
      fd.append('assets', b64blob(a), img.filename);
    }
    progress(0, 1, `Sending "${p.title}" to WordPress…`);
    log(`Publishing "${p.title}" as ${t.status}`);
    let j;
    try { j = await api('/api/publish', { method: 'POST', body: fd }); }
    catch (e) {
      // Media IDs from an earlier publish may have been deleted in WordPress; retry once with fresh uploads.
      if (e.status === 422 && wp?.media && /missing from this device/.test(e.message)) { p.wp = { ...wp, media: {} }; progress(null); return publish(p, n); }
      progress(null); throw e;
    }
    progress(null);
    p.wp = { id: j.id, link: j.link, status: j.status, media: { ...(wp?.media || {}), ...(j.media || {}) }, at: Date.now() };
    // WordPress now owns the media. Release the large local blobs automatically so hundreds of posts do not fill browser storage.
    for (const img of images(p)) if (p.wp.media?.[img.filename] || p.wp.media?.[lc(img.filename)]) await assetDel(img.filename).catch(() => {});
    p.pending = [];
    await saveWs();
    const pl = j.placements || {}, adsTxt = [pl.top && `${pl.top} top`, pl.side && `${pl.side} side`, pl.inline && `${pl.inline} in-content`, pl.textLinks && `${pl.textLinks} text link${pl.textLinks > 1 ? 's' : ''}`, pl.end && 'resources list'].filter(Boolean).join(', ');
    const msg = `${j.updated ? 'Updated' : 'Created'} "${p.title}" — ${statusLabel[j.status] || j.status} (#${j.id}, ${j.uploadedImages} image${j.uploadedImages === 1 ? '' : 's'} uploaded${adsTxt ? `; ads: ${adsTxt}` : ''})`;
    log(msg, 'ok'); toast(msg, 'ok');
    return j;
  }
  $('#publishAll').onclick = async () => {
    if (busy) return;
    const list = ws.posts.filter(p => p.validation?.ok);
    if (!list.length) return toast('No posts are ready to publish.', 'warn');
    const t0 = targetFor({}, 0);
    if (!confirm(`Send ${list.length} post${list.length > 1 ? 's' : ''} to WordPress as ${describe(t0)}${t0.status === 'future' && Number($('#bulkGap').value) ? `, then every ${$('#bulkGap').selectedOptions[0].text}` : ''}?`)) return;
    busy = true; let ok = 0, fail = 0;
    for (let k = 0; k < list.length; k++) {
      progress(k, list.length, `Post ${k + 1} of ${list.length}`);
      try { await publish(list[k], k); ok++; }
      catch (e) { fail++; log(`${list[k].title}: ${e.message}`, 'bad'); if (e.status === 401 || /authentication|not allowed to publish|can only save drafts/i.test(e.message)) { toast(e.message, 'bad', 9000); break; } }
      render();
      if (k < list.length - 1) await sleep(2000); // pace WordPress + engine requests
    }
    busy = false; progress(null); render();
    toast(`Done: ${ok} sent${fail ? `, ${fail} failed (see Activity)` : ''}.`, fail ? 'warn' : 'ok', 7000);
  };
  $('#genAll').onclick = async () => {
    await refreshPending(); if (!ws.posts.some(p => p.pending?.length)) return toast('All photos are ready.', 'ok');
    if (!canGenerate()) return toast('Image generation is not configured. Add OPENAI_API_KEY on Render or your own key in Connections.', 'bad', 8000);
    if (worker.on) { worker.paused = false; return photoStatus('Resumed'); }
    const was = S.standard.autoGenerate; S.standard.autoGenerate = true; startPhotoWorker(); S.standard.autoGenerate = was;
  };
  $('#photoPause').onclick = () => { worker.paused = !worker.paused; photoStatus(worker.paused ? 'Paused' : 'Resuming…'); };
  $('#clearAll').onclick = async () => { if (!ws.posts.length || !confirm('Remove every post and stored image from this queue? WordPress is not touched.')) return; ws.posts = []; await assetClearUser(uid); await saveWs(); render(); toast('Queue and local photo cache cleared.'); };

  // ---------- preview ----------
  const urls = [];
  function inline(s) { let t = esc(s); t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>'); return t; }
  function resolveAd(sec, idx, p) {
    const lib = (S.ads || []).filter(a => a && a.enabled !== false && (a.url || a.html));
    const fromLib = lib.find(a => a.slot && a.slot === sec.slot) || (lib.length ? lib[(hash(p.slug || p.title) + idx) % lib.length] : null);
    if (sec.html) return { html: sec.html };
    if (sec.url) return { ...(fromLib || {}), ...Object.fromEntries(Object.entries(sec).filter(([, v]) => v)), html: '' };
    return fromLib;
  }
  async function imgTag(img, cls = '') {
    const a = await assetGet(img.filename);
    if (!a) return `<figure class="ph ${cls}"><div><b>Image will be generated</b><small>${esc(img.prompt || '')}</small></div><figcaption>Alt: ${esc(img.alt_text)}</figcaption></figure>`;
    const u = URL.createObjectURL(b64blob(a)); urls.push(u);
    return `<figure class="${cls}"><img src="${u}" alt="${esc(img.alt_text)}">${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}<small class="alt">Alt: ${esc(img.alt_text)}</small></figure>`;
  }
  async function preview(p) {
    urls.splice(0).forEach(u => URL.revokeObjectURL(u));
    try {
      const j = await api('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ post: (({ source, validation, pending, wp, target, ...x }) => x)(p), options: { ads: S.ads, adLabel: S.adLabel, adLayout: S.adLayout } }) }, 1);
      let html = j.html.replace(/<!-- \/?wp:[^>]*-->/g, '');
      const names = [...new Set([...html.matchAll(/aura-asset:([^"]+)/g)].map(m => m[1]))];
      for (const n of names) {
        const a = await assetGet(n);
        const img = images(p).find(i => lc(i.filename) === lc(n));
        const rep2 = a ? (() => { const u = URL.createObjectURL(b64blob(a)); urls.push(u); return u; })() : '';
        html = a ? html.split(`aura-asset:${n}`).join(rep2) : html.replace(new RegExp(`<figure[^>]*>\\s*<img src="aura-asset:${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>(.*?)</figure>`, 's'), `<figure class="ph"><div><b>Photo will be generated</b><small>${esc(img?.art?.scene || img?.prompt || '')}</small></div></figure>`);
      }
      const hero = p.featured_image ? await imgTag(p.featured_image, 'hero') : '';
      const st = p.standard?.stats || {}, pl = j.placements || {};
      $('#previewMeta').textContent = `${st.words || 0} words · ${st.minutes || 0} min · ${st.images || 0} photos · ads: ${pl.top || 0} top, ${pl.side || 0} side, ${pl.inline || 0} in-content, ${pl.textLinks || 0} links${pl.end ? ', resources list' : ''}`;
      let host = 'yoursite.com'; try { host = new URL(S.wp.url).hostname; } catch {}
      const serp = `<div class="serp"><small>Google preview</small><cite>${esc(host)} › ${esc(p.slug || '')}</cite><b>${esc(p.meta_title || p.title)}</b><p>${esc(p.meta_description || p.excerpt || '')}</p><small>Focus keyphrase: ${esc(p.focus_keyphrase || p.primary_keyword || '—')} · Excerpt: ${esc(p.excerpt || '—')}</small></div>`;
      $('#previewBody').innerHTML = `${serp}<h1>${esc(p.title)}</h1>${hero}<div class="wp-preview">${html}</div>`;
      $('#preview').showModal();
      return;
    } catch (e) { log(`Exact preview unavailable (${e.message}); showing a simple preview.`, 'warn'); }
    let adI = 0, out = `<h1>${esc(p.title)}</h1>`;
    if (p.featured_image) out += await imgTag(p.featured_image, 'hero');
    for (let i = 0; i < p.sections.length; i++) {
      const s = p.sections[i], prev = p.sections[i - 1];
      if (s.type === 'heading') out += `<h${s.level}>${inline(s.content)}</h${s.level}>`;
      else if (s.type === 'intro') out += `<p class="lead">${inline(s.content)}</p>`;
      else if (s.type === 'image') out += await imgTag(s);
      else if (s.type === 'ad') {
        const ad = resolveAd(s, adI++, p);
        out += !ad ? `<aside class="adcard empty-ad">${esc(S.adLabel)} · ${esc(s.slot)} — empty (add an ad in Standard &amp; ads)</aside>` : ad.html ? `<aside class="adcard"><small>${esc(S.adLabel)} · HTML ad code</small><code>${esc(ad.html.slice(0, 140))}…</code></aside>` : `<aside class="adcard"><small>${esc(S.adLabel)}</small><b>${esc(ad.label || 'Recommended resource')}</b>${ad.text ? `<p>${esc(ad.text)}</p>` : ''}<a href="${esc(ad.url)}" target="_blank" rel="noopener sponsored">${esc(ad.cta || 'Learn more')}</a></aside>`;
      }
      else if (s.type === 'list') out += `<${s.ordered ? 'ol' : 'ul'}>${s.items.map(x => `<li>${inline(x)}</li>`).join('')}</${s.ordered ? 'ol' : 'ul'}>`;
      else if (s.type === 'checklist') out += `${s.title && prev?.type !== 'heading' ? `<h2>${esc(s.title)}</h2>` : ''}<ul class="checklist">${s.items.map(x => `<li>${inline(x)}</li>`).join('')}</ul>`;
      else if (s.type === 'callout') out += `<aside class="callout">${s.label ? `<b>${esc(s.label)}</b>` : ''}<p>${inline(s.content)}</p></aside>`;
      else if (s.type === 'html') out += `<div class="rawhtml">${s.content}</div>`;
      else out += `<p>${inline(s.content)}</p>`;
    }
    const st = p.standard?.stats || {};
    $('#previewMeta').textContent = `${st.words || 0} words · ${st.minutes || 0} min read · ${st.h2 || 0} H2 · ${st.images || 0} images · ${st.ads || 0} ads`;
    $('#previewBody').innerHTML = out;
    $('#preview').showModal();
  }
  $('#closePreview').onclick = () => $('#preview').close();

  // ---------- import ----------
  async function importFiles(files) {
    if (!files?.length) return toast('Choose a ZIP, JSON, CSV or document first.', 'warn');
    const fd = new FormData(); [...files].forEach(f => fd.append('files', f));
    const replace = $('#replaceQueue').checked;
    const existing = replace ? [] : await assetKeys();
    fd.append('options', JSON.stringify({ ...stdOptions(), existingAssets: existing }));
    $('#importState').textContent = 'Analyzing package…';
    try {
      const j = await api('/api/import', { method: 'POST', body: fd });
      if (!Array.isArray(j.posts)) throw new Error('Unexpected response. Deploy the V11 server (API 5.0.0) and reload this page.');
      if (replace) { await assetClearUser(uid); ws.posts = []; }
      for (const a of j.assets || []) await assetPut(a);
      const byId = new Map(ws.posts.map((p, i) => [p.post_id, i]));
      rememberSigs(j.posts);
      ws.lastBatch = j.posts.map(p => p.post_id);
      for (const n of j.rejectedImages || []) await assetDel(n).catch(() => {}); // never keep drawn placeholders
      for (const p of j.posts) { const at = byId.get(p.post_id); if (at != null) { p.wp = ws.posts[at].wp; p.target = ws.posts[at].target; ws.posts[at] = p; } else ws.posts.push(p); }
      await refreshPending(); render();
      const pend = ws.posts.reduce((t, p) => t + (p.pending?.length || 0), 0);
      const fixes = j.posts.reduce((t, p) => t + (p.standard?.notes?.length || 0), 0);
      const rej = (j.rejectedImages || []).length, byOrder = j.matchedByOrder || 0;
      $('#importState').textContent = `Imported ${j.posts.length} posts and ${j.assets.length} images from ${j.manifestSource || 'files'} · ${j.summary.ready} ready · ${fixes} auto-fixes · ${pend} images to generate${byOrder ? ` · ${byOrder} ZIP photo${byOrder > 1 ? 's' : ''} matched by order` : ''}${rej ? ` · ${rej} drawn placeholder image${rej > 1 ? 's' : ''} discarded` : ''}${pend && canGenerate() ? ' · photos are being created now' : ''}.`;
      log($('#importState').textContent, 'ok');
      switchTab('queue');
      if (pend) setTimeout(startPhotoWorker, 300);
    } catch (e) { $('#importState').textContent = `Import failed: ${e.message}`; toast(e.message, 'bad', 8000); }
  }
  $('#importBtn').onclick = () => importFiles($('#files').files);
  $('#files').addEventListener('change', () => { const f = [...$('#files').files]; $('#filesPicked').hidden = !f.length; $('#filesPicked').textContent = f.length === 1 ? `Selected: ${f[0].name}` : `${f.length} files selected`; });
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('drag'); importFiles(e.dataTransfer.files); };

  // ---------- ChatGPT photos: order-matched, converted to web JPGs, confirmed by the user ----------
  let pickPhotosFor = null, matchState = null;
  const slotLabel = (p, img) => img.featured ? 'Featured' : /inline-(\d+)/i.test(img.filename) ? `Inline ${img.filename.match(/inline-(\d+)/i)[1]}` : 'Inline';
  function photoSlots(ids) {
    const order = ids?.length ? ids : ws.lastBatch?.length ? ws.lastBatch : ws.posts.map(p => p.post_id);
    return order.map(id => ws.posts.find(p => p.post_id === id)).filter(Boolean).flatMap(p => images(p).map(img => ({ p, img })));
  }
  async function toJpeg(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    const dataBase64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
    return { name: file.name, mime: 'image/jpeg', dataBase64, size: blob.size, w: c.width, h: c.height, url: URL.createObjectURL(blob), lastModified: file.lastModified };
  }
  async function addPhotos(fileList, ids) {
    const files = [...(fileList || [])].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (!files.length) return toast('Choose photo files.', 'warn');
    const slots = photoSlots(ids);
    if (!slots.length) return toast('Import the ZIP first, then add its photos.', 'warn');
    $('#photoState').textContent = `Preparing ${files.length} photo${files.length > 1 ? 's' : ''}…`;
    const photos = [];
    for (const f of files) {
      try { const ph = await toJpeg(f); ph.drawn = await isPlaceholder(ph); photos.push(ph); }
      catch { toast(`Could not read ${f.name}. On iPhone, share it as JPG or PNG.`, 'bad'); }
    }
    // exact filename matches first, then the rest in the order they were saved
    const have = new Set((await assetKeys()).map(lc));
    const byName = new Map(photos.map((ph, k) => [lc(ph.name).replace(/\.(png|webp|jpeg)$/i, '.jpg'), k]));
    const assign = new Map(), usedPh = new Set();
    slots.forEach((sl, si) => { const k = byName.get(lc(sl.img.filename)); if (k != null && !photos[k].drawn) { assign.set(si, k); usedPh.add(k); } });
    const rest = photos.map((ph, k) => k).filter(k => !usedPh.has(k) && !photos[k].drawn).sort((a, b) => (photos[a].lastModified - photos[b].lastModified) || photos[a].name.localeCompare(photos[b].name, undefined, { numeric: true }));
    const open = slots.map((sl, si) => si).filter(si => !assign.has(si) && !have.has(lc(slots[si].img.filename)));
    const fill = open.length >= rest.length ? open : slots.map((_, si) => si).filter(si => !assign.has(si));
    rest.forEach((k, n) => { if (fill[n] != null) assign.set(fill[n], k); });
    const drawn = photos.filter(ph => ph.drawn).length;
    matchState = { slots, photos, assign };
    renderMatcher();
    $('#matchMeta').textContent = `${assign.size} of ${slots.length} spots matched${drawn ? ` · ${drawn} drawn placeholder${drawn > 1 ? 's' : ''} skipped` : ''}`;
    $('#photoState').textContent = '';
    $('#matcher').showModal();
  }
  function renderMatcher() {
    const { slots, photos, assign } = matchState;
    $('#matchList').innerHTML = slots.map((sl, si) => {
      const k = assign.get(si), ph = k != null ? photos[k] : null;
      return `<div class="mrow"><div class="mthumb">${ph ? `<img src="${ph.url}" alt="">` : '<span>Empty</span>'}</div>
        <div class="minfo"><b>${esc(sl.p.title)}</b><small>${slotLabel(sl.p, sl.img)} · ${esc(sl.img.filename)}</small><small class="muted">${esc(sl.img.alt_text || sl.img.art?.scene || '')}</small>
        <select data-si="${si}" aria-label="Photo for ${esc(sl.img.filename)}"><option value="">— keep current / generate —</option>${photos.map((p2, pk) => p2.drawn ? '' : `<option value="${pk}" ${pk === k ? 'selected' : ''}>Photo ${pk + 1} · ${esc(p2.name.slice(0, 32))}</option>`).join('')}</select></div></div>`;
    }).join('');
  }
  $('#matchList').addEventListener('change', e => { const sel = e.target.closest('select[data-si]'); if (!sel) return; const si = Number(sel.dataset.si); if (sel.value === '') matchState.assign.delete(si); else matchState.assign.set(si, Number(sel.value)); renderMatcher(); });
  $('#closeMatch').onclick = () => { matchState?.photos.forEach(ph => URL.revokeObjectURL(ph.url)); matchState = null; $('#matcher').close(); };
  $('#saveMatch').onclick = async () => {
    const { slots, photos, assign } = matchState; let n = 0;
    for (const [si, k] of assign) { const ph = photos[k], sl = slots[si]; await assetPut({ name: sl.img.filename, mime: 'image/jpeg', dataBase64: ph.dataBase64, size: ph.size }); if (sl.p.wp?.media) delete sl.p.wp.media[sl.img.filename]; n++; }
    photos.forEach(ph => URL.revokeObjectURL(ph.url)); matchState = null; $('#matcher').close();
    await refreshPending(); saveWs(); render();
    const left = ws.posts.reduce((t, p) => t + (p.pending?.length || 0), 0);
    toast(`${n} photo${n === 1 ? '' : 's'} saved.${left ? ` ${left} still missing (Aura can generate them).` : ''}`, 'ok', 6000); log(`Added ${n} ChatGPT photos`, 'ok');
    $('#photoState').textContent = `${n} photos added · ${left} still missing`;
  };
  $('#photoFiles').onchange = async () => { const f = $('#photoFiles').files, ids = pickPhotosFor; pickPhotosFor = null; await addPhotos(f, ids); $('#photoFiles').value = ''; };

  // ---------- standard & ads ----------
  function fillStandard() {
    $('#stEnforce').checked = S.standard.enforce; $('#stAutoGen').checked = S.standard.autoGenerate; $('#stQuality').value = S.standard.quality;
    $('#stCover').value = S.standard.coverStyle || (S.standard.heroText === false ? 'photo' : 'full'); $('#stRejectPh').checked = S.standard.rejectPlaceholders !== false;
    $('#stIpm').value = String(S.standard.imagesPerMinute || 4);
    $('#stAlt').value = S.standard.altTemplate; $('#stStyle').value = S.standard.style; $('#adLabel').value = S.adLabel;
    const L = S.adLayout;
    $('#lyTop').checked = L.top; $('#lySide').checked = L.side; $('#lyText').checked = L.textLinks; $('#lyEnd').checked = L.end; $('#lyDisc').checked = L.disclosure;
    $('#lyTopPos').value = L.topPosition; $('#lySideMax').value = String(L.sideMax); $('#lyTextMax').value = String(L.textLinkMax); $('#lyDensity').value = String(L.wordsPerAd); $('#lyEndMax').value = String(L.endMax); $('#lyDiscText').value = L.disclosureText;
    renderAds();
  }
  const adSlug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/-$/, '');
  const PLACES = [['top', 'Top'], ['side', 'Side'], ['inline', 'In-content'], ['text', 'Text links'], ['end', 'Resources']];
  function renderAds() {
    const q = ($('#adFilter')?.value || '').toLowerCase();
    const rows = S.ads.map((a, i) => ({ a, i })).filter(({ a }) => !q || JSON.stringify(a).toLowerCase().includes(q));
    $('#adList').innerHTML = rows.length ? rows.map(({ a, i }) => {
      const pl = new Set(a.placements?.length ? a.placements : PLACES.map(p => p[0]));
      return `<details class="ad-row" data-i="${i}" ${a._open ? 'open' : ''}>
      <summary><b>${esc(a.name || a.label || 'New link')}</b><code>${esc(adSlug(a.id || a.name || a.label) || '—')}</code><small>${esc((a.keywords || '').toString().slice(0, 60))}</small>${a.enabled === false ? '<span class="b">Off</span>' : ''}</summary>
      <div class="grid2">
        <label>Name<input data-k="name" value="${esc(a.name)}" placeholder="e.g. Calm Weighted Blanket"></label>
        <label>Link URL<input data-k="url" value="${esc(a.url)}" placeholder="https://…" inputmode="url"></label>
        <label>Keywords (where it fits)<input data-k="keywords" value="${esc(Array.isArray(a.keywords) ? a.keywords.join(', ') : a.keywords)}" placeholder="weighted blanket, sleep, anxiety"></label>
        <label>Headline<input data-k="label" value="${esc(a.label)}" placeholder="The 5-minute gratitude journal"></label>
        <label>Button text<input data-k="cta" value="${esc(a.cta)}" placeholder="See the journal"></label>
        <label>One-line description<input data-k="text" value="${esc(a.text)}"></label>
        <label>Image URL (optional)<input data-k="image" value="${esc(a.image)}"></label>
        <label>ID used in the prompt<input data-k="id" value="${esc(a.id || '')}" placeholder="${esc(adSlug(a.name || a.label))}"></label>
      </div>
      <fieldset class="places"><legend>May appear as</legend>${PLACES.map(([k, t]) => `<label class="check"><input type="checkbox" data-pl="${k}" ${pl.has(k) ? 'checked' : ''}> ${t}</label>`).join('')}</fieldset>
      <label>HTML ad code (optional, replaces the link card)<textarea data-k="html" rows="2">${esc(a.html)}</textarea></label>
      <div class="row between"><label class="check"><input type="checkbox" data-k="enabled" ${a.enabled !== false ? 'checked' : ''}> Active</label><button class="ghost danger sm" data-del="${i}">Remove</button></div>
    </details>`; }).join('') : `<p class="muted">${S.ads.length ? 'No matches.' : 'No links yet. Paste your list above. Empty ad slots publish as a placeholder your ad plugin can fill.'}</p>`;
  }
  // Read edits back from visible rows; filtered-out rows keep their stored values.
  function readAds() {
    const out = S.ads.map(a => ({ ...a }));
    $$('.ad-row').forEach(r => {
      const i = Number(r.dataset.i), o = out[i]; if (!o) return;
      r.querySelectorAll('[data-k]').forEach(el => o[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value.trim());
      o.placements = [...r.querySelectorAll('[data-pl]')].filter(x => x.checked).map(x => x.dataset.pl);
      o.id = adSlug(o.id || o.name || o.label); o._open = r.open;
    });
    return out;
  }
  const blankAd = () => ({ id: '', name: '', url: '', keywords: '', label: '', cta: 'Learn more', text: '', image: '', html: '', placements: PLACES.map(p => p[0]), enabled: true });
  $('#addAd').onclick = () => { S.ads = readAds(); S.ads.unshift({ ...blankAd(), _open: true }); $('#adFilter').value = ''; renderAds(); };
  $('#adList').onclick = e => { const d = e.target.closest('[data-del]'); if (!d) return; e.preventDefault(); S.ads = readAds(); S.ads.splice(Number(d.dataset.del), 1); renderAds(); };
  $('#adFilter').oninput = () => { S.ads = readAds(); renderAds(); };
  function parseAdList(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const out = [];
    for (const l of lines) {
      let parts = l.includes('|') ? l.split('|') : l.includes('\t') ? l.split('\t') : null;
      if (!parts) { // comma separated: name, url, keywords…
        const m = l.match(/^(.*?)[,;]\s*(https?:\/\/\S+?)(?:[,;]\s*(.*))?$/);
        parts = m ? [m[1], m[2], m[3] || ''] : [l];
      }
      parts = parts.map(x => x.trim());
      let [name, url, keywords = '', cta = '', text = '', image = ''] = parts;
      if (/^https?:\/\//i.test(name) && !/^https?:\/\//i.test(url || '')) [name, url] = [url || '', name];
      if (/^name$/i.test(name) && /url|link/i.test(url || '')) continue; // header row
      if (!/^https?:\/\//i.test(url || '')) continue;
      if (!name) try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = 'Link'; }
      out.push({ ...blankAd(), id: adSlug(name), name, url, keywords, cta: cta || 'Learn more', text, image, label: name });
    }
    return out;
  }
  $('#adBulkAdd').onclick = async () => {
    const list = parseAdList($('#adBulk').value);
    if (!list.length) return toast('No lines with a link found. Use: Name | https://link | keywords', 'warn');
    S.ads = readAds();
    let added = 0, updated = 0;
    for (const a of list) {
      const at = S.ads.findIndex(x => x.url === a.url || adSlug(x.id || x.name) === a.id);
      if (at > -1) { S.ads[at] = { ...S.ads[at], ...Object.fromEntries(Object.entries(a).filter(([k, v]) => v && k !== 'placements')) }; updated++; }
      else { S.ads.push(a); added++; }
    }
    const ids = new Map(); for (const a of S.ads) { let id = adSlug(a.id || a.name) || 'link', k = 2; while (ids.has(id)) id = `${adSlug(a.id || a.name)}-${k++}`; ids.set(id, 1); a.id = id; }
    await V.save(S); renderAds(); buildPrompt(); updateDetails();
    $('#adBulk').value = ''; $('#adBulkState').textContent = `${added} added, ${updated} updated · ${S.ads.length} in library`;
    toast(`Library saved: ${added} added, ${updated} updated.`, 'ok');
  };
  $('#saveAds').onclick = async () => {
    const ads = readAds(); const bad = ads.find(a => a.url && !/^https?:\/\//i.test(a.url));
    if (bad) return toast(`Link must start with https:// (${bad.url})`, 'bad');
    S.ads = ads.map(({ _open, ...a }) => a); S.adLabel = $('#adLabel').value.trim() || 'Sponsored'; await V.save(S); buildPrompt(); updateDetails(); renderAds(); toast('Library saved. Links are placed where their keywords fit.', 'ok');
  };
  $('#saveLayout').onclick = async () => {
    Object.assign(S.adLayout, { top: $('#lyTop').checked, side: $('#lySide').checked, textLinks: $('#lyText').checked, end: $('#lyEnd').checked, disclosure: $('#lyDisc').checked,
      topPosition: $('#lyTopPos').value, sideMax: Number($('#lySideMax').value), textLinkMax: Number($('#lyTextMax').value), wordsPerAd: Number($('#lyDensity').value), endMax: Number($('#lyEndMax').value), disclosureText: $('#lyDiscText').value.trim() || DEFAULTS.adLayout.disclosureText });
    await V.save(S); toast('Ad placement saved. Preview a post to see it.', 'ok');
  };
  $('#copyCss').onclick = async () => {
    try { const r = await fetch(API + '/api/ad-css', { cache: 'no-store' }); const css = await r.text(); await navigator.clipboard.writeText(css); toast('CSS copied. Paste it in Appearance → Customize → Additional CSS.', 'ok'); }
    catch (e) { toast('Could not copy the CSS: ' + e.message, 'bad'); }
  };
  $('#saveStandard').onclick = async () => {
    Object.assign(S.standard, { enforce: $('#stEnforce').checked, autoGenerate: $('#stAutoGen').checked, quality: $('#stQuality').value, coverStyle: $('#stCover').value, heroText: $('#stCover').value !== 'photo', rejectPlaceholders: $('#stRejectPh').checked, imagesPerMinute: Number($('#stIpm').value), altTemplate: $('#stAlt').value.trim() || DEFAULTS.standard.altTemplate, style: $('#stStyle').value.trim() });
    await V.save(S); updateDetails(); toast(ws.posts.length ? 'Standard saved. Tap "Re-apply to queue" to update posts already imported.' : 'Standard saved.', 'ok', 6000);
  };
  $('#reapply').onclick = async () => {
    if (!ws.posts.length) return toast('The queue is empty.', 'warn');
    try {
      const j = await api('/api/standardize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: ws.posts.map(({ validation, pending, ...p }) => p), options: stdOptions(), assetNames: await assetKeys() }) });
      ws.posts = j.posts; rememberSigs(j.posts); await refreshPending(); render(); toast('Standard re-applied to the queue.', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  };

  // ---------- prompt ----------
  const pFields = { pSite: 'siteName', pCount: 'count', pNiche: 'niche', pAudience: 'audience', pVoice: 'voice', pTopics: 'topics', pExtra: 'extra', pBatchSize: 'batchSize' };
  const promptCfg = () => ({ ...S.prompt, ads: S.ads });
  function buildPrompt() {
    if (!S) return;
    const pl = window.AuraPrompt.plan(promptCfg());
    const n = pl.batches.length;
    S.prompt.batch = Math.min(Math.max(0, S.prompt.batch || 0), n - 1);
    $('#pBatch').innerHTML = pl.batches.map((b, i) => `<option value="${i}">${i + 1} of ${n}${b[0] ? ` — ${esc(b[0].topic.slice(0, 40))}` : ''}</option>`).join('');
    $('#pBatch').value = String(S.prompt.batch);
    $('#promptOut').value = window.AuraPrompt.build(promptCfg(), S.prompt.batch);
    $('#pTopicsHint').textContent = pl.topics.length ? `${pl.topics.length} posts in your list → ${n} batch${n > 1 ? 'es' : ''} of up to ${pl.size}.` : 'Leave empty to let ChatGPT choose topics.';
    const ads = (S.ads || []).filter(a => a.enabled !== false && (a.url || a.html)).length;
    $('#pState').textContent = `Batch ${S.prompt.batch + 1} of ${n} · ${ads} affiliate link${ads === 1 ? '' : 's'} included · paste one batch per ChatGPT reply, import each ZIP.`;
    updateDetails();
  }
  Object.entries(pFields).forEach(([id, k]) => $('#' + id).addEventListener('input', () => {
    S.prompt[k] = ['pCount', 'pBatchSize'].includes(id) ? Number($('#' + id).value) : $('#' + id).value;
    if (id === 'pTopics' || id === 'pBatchSize' || id === 'pCount') S.prompt.batch = 0;
    clearTimeout(buildPrompt.t); buildPrompt.t = setTimeout(() => { buildPrompt(); V.save(S).catch(() => {}); }, 250);
  }));
  $('#pBatchSize').addEventListener('change', () => $('#pBatchSize').dispatchEvent(new Event('input')));
  $('#pBatch').onchange = () => { S.prompt.batch = Number($('#pBatch').value); buildPrompt(); V.save(S).catch(() => {}); };
  $('#nextBatch').onclick = () => { const n = window.AuraPrompt.plan(promptCfg()).batches.length; if (S.prompt.batch >= n - 1) return toast('That was the last batch.', 'ok'); S.prompt.batch++; buildPrompt(); V.save(S).catch(() => {}); };
  $('#copyPrompt').onclick = async () => { try { await navigator.clipboard.writeText($('#promptOut').value); toast(`Batch ${S.prompt.batch + 1} copied. Paste it into ChatGPT.`, 'ok'); } catch { $('#promptOut').select(); document.execCommand('copy'); toast('Prompt copied.', 'ok'); } };
  $('#dlPrompt').onclick = () => download('aura-chatgpt-prompts.md', window.AuraPrompt.buildAll(promptCfg()), 'text/markdown');
  function download(name, text, type = 'application/json') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

  // ---------- connections ----------
  function fillConnections() { $('#wpUrl').value = S.wp.url; $('#wpUser').value = S.wp.username; $('#wpPass').value = S.wp.appPassword; $('#wpMode').value = S.publish.mode; $('#oaKey').value = S.openaiKey || ''; $('#apiBase').textContent = API; }
  const wpForm = () => ({ url: $('#wpUrl').value.trim(), username: $('#wpUser').value.trim(), appPassword: $('#wpPass').value.trim() });
  async function testWp(w) {
    const j = await api('/api/wp/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wordpress: w }) });
    return j;
  }
  $('#testWp').onclick = async () => {
    $('#wpState').textContent = 'Testing…'; $('#wpState').className = 'muted';
    try { const j = await testWp(wpForm()); $('#wpState').innerHTML = `Connected as <b>${esc(j.user?.name)}</b> (${esc((j.user?.roles || []).join(', ') || 'user')}). ${j.canPublish ? 'Can publish live posts.' : '<span class="bad">This role can only save drafts. Use an Author, Editor or Administrator to publish.</span>'}`; $('#wpState').className = 'ok'; }
    catch (e) { $('#wpState').textContent = e.message; $('#wpState').className = 'bad'; }
  };
  $('#saveWp').onclick = async () => {
    const w = wpForm();
    if (!w.url || !w.username || w.appPassword.replace(/\s/g, '').length < 16) return toast('Fill in all three WordPress fields.', 'warn');
    const hadRec = V.current()?.hasRecovery;
    S.wp = w; S.publish.mode = $('#wpMode').value; await V.save(S); updateDetails();
    toast(hadRec ? 'WordPress connection saved to your account.' : 'WordPress connection saved. Password reset is now turned on with this Application Password.', 'ok');
  };
  $('#saveOa').onclick = async () => { S.openaiKey = $('#oaKey').value.trim(); await V.save(S); await refreshPending(); render(); genState(); toast('Saved.', 'ok'); };
  function genState() { $('#genState').textContent = health.features?.imageGeneration ? `The engine generates images with ${health.features.imageModel}. No key needed here.` : S?.openaiKey ? 'Using your OpenAI key for image generation.' : health.online ? 'The engine has no OpenAI key. Add yours below, or set OPENAI_API_KEY on Render.' : 'Engine offline.'; }
  $('#testApi').onclick = async () => { try { const j = await api('/healthz'); toast(`${j.service} ${j.version} online`, 'ok'); } catch (e) { toast(e.message, 'bad'); } };


  // ---------- V16.1 WordPress Site Studio ----------
  const TB_PRESETS = [
    { id:'gardening', targetSlug:'gardening', icon:'🌿', name:'Gardening — Garden Journal', eyebrow:'GARDENING', title:'Grow something beautiful, wherever you live.', intro:'Practical gardening guides for beginners, small spaces, seasonal planting, soil, containers and outdoor living.', accent:'#2d7d55', variant:'editorial', blocks:[
      {type:'topics',title:'Start here',items:['Beginner Gardening','Container Gardens','Small Spaces','Soil & Compost']},
      {type:'feature',title:'Featured this week',text:'A hand-picked guide with practical steps, beautiful photography and a clear next action.'},
      {type:'grid',title:'Latest from the garden',items:['Seasonal planting','Garden projects','Growing food','Outdoor living','Plant care','Beginner guides']},
      {type:'list',title:'Popular gardening guides',items:['What to plant this month','A simple beginner garden plan','Build healthier soil naturally','Container gardening that actually works']},
      {type:'cta',title:'Seasonal garden guide',text:'Know what to plant, prepare and maintain right now.',button:'Explore seasonal guides'} ] },
    { id:'home', targetSlug:'home-diy', icon:'🏡', name:'Home & DIY — The Home Edit', eyebrow:'HOME & DIY', title:'Make your home work better for real life.', intro:'Approachable DIY projects, organization systems and affordable upgrades that make everyday spaces easier to live in.', accent:'#9b6a3b', variant:'bold', blocks:[
      {type:'topics',title:'Make your home better',items:['DIY Projects','Organization','Decorating','Cleaning','Home Upgrades']},{type:'feature',title:'Project of the week',text:'Highlight one useful project with difficulty, time and budget at a glance.'},{type:'grid',title:'Quick projects',items:['Weekend DIY','Easy upgrade','Organization','Decorating']},{type:'cta',title:'Shop the project',text:'Useful tools and materials connected naturally to the project.',button:'See project picks'} ] },
    { id:'mental', targetSlug:'mental-wellness', icon:'🧠', name:'Mental Wellness — The Calm Space', eyebrow:'MENTAL WELLNESS', title:'A quieter place for clearer thoughts.', intro:'Grounded guidance for calmer routines, reflection, stress management and everyday personal growth.', accent:'#7b61a8', variant:'calm', blocks:[
      {type:'topics',title:'How are you feeling today?',items:['Overwhelmed','Unmotivated','Stressed','Need Rest','Need Direction']},{type:'feature',title:'A moment for you',text:'A slower editorial feature that gives the reader one useful place to begin.'},{type:'grid',title:'Tools for everyday life',items:['Calm routines','Mindfulness','Personal growth','Stress management']},{type:'quote',title:'A small reminder',text:'You do not have to solve everything today.'} ] },
    { id:'healthy', targetSlug:'healthy-living', icon:'🥗', name:'Healthy Living — Everyday Wellness', eyebrow:'HEALTHY LIVING', title:'Small choices. Healthier days.', intro:'Realistic ideas for nutrition, movement, sleep, healthy habits and everyday energy.', accent:'#2378d2', variant:'cards', blocks:[
      {type:'topics',title:'Explore wellness',items:['Nutrition','Movement','Sleep','Healthy Habits','Everyday Energy']},{type:'feature',title:"Today's feature",text:'Simple, realistic guidance you can actually use.'},{type:'grid',title:'Eat better',items:['Food guides','Nutrition basics','Grocery planning']},{type:'grid',title:'Feel better',items:['Movement','Sleep','Daily routine']},{type:'cta',title:'Wellness picks',text:'Thoughtful products and resources that fit naturally into healthy routines.',button:'Browse wellness picks'} ] },
    { id:'careers', targetSlug:'helping-careers', icon:'💼', name:'Helping Careers — Work With Purpose', eyebrow:'HELPING CAREERS', title:'Build a career that supports your life and helps others.', intro:'Career pathways, requirements, workplace realities and practical tools for people drawn to meaningful work.', accent:'#152e4d', variant:'editorial', blocks:[
      {type:'topics',title:'Find your path',items:['Healthcare','Education','Social Services','Remote Work','Career Growth']},{type:'feature',title:'Career spotlight',text:'Profile a helping career with education, skills, salary context and next steps.'},{type:'steps',title:'How to get started',items:['Explore the career','Understand requirements','Build your skills','Apply strategically']},{type:'grid',title:'Career resources',items:['Resume','Interviewing','Certifications','Job Search']} ] },
    { id:'family', targetSlug:'family-parenting', icon:'👨‍👩‍👧‍👦', name:'Family & Parenting — Family Life', eyebrow:'FAMILY & PARENTING', title:'Practical support for the beautiful, busy reality of family life.', intro:'Warm, useful ideas for parenting, organization, working families, activities and faith at home.', accent:'#c05b68', variant:'editorial', blocks:[
      {type:'topics',title:'What does your family need?',items:['Organization','Parenting','Family Activities','Faith at Home','Working Parents']},{type:'feature',title:'Featured family guide',text:'Put one deeply useful family guide front and center.'},{type:'grid',title:'Solutions for busy parents',items:['10-minute reads','Checklists','Step-by-step guides','Weekend projects']},{type:'cta',title:'Family favorites',text:'Useful resources and products selected for everyday family life.',button:'Explore family favorites'} ] },
    { id:'resources', targetSlug:'resources', icon:'📚', name:'Resources — Mindful Adaption Library', eyebrow:'MINDFUL ADAPTION RESOURCES', title:'Useful tools for a calmer, healthier and more organized life.', intro:'Free guides, printables, trackers, checklists and practical tools organized by what you need.', accent:'#2378d2', variant:'cards', destination:'page', blocks:[
      {type:'topics',title:'Explore the library',items:['Gardening','Home','Wellness','Healthy Living','Careers','Family']},{type:'resources',title:'Most popular',items:['Printable Weekly Reset Planner','Beginner Garden Checklist','Healthy Habit Tracker']},{type:'grid',title:'Free printables',items:['Weekly planner','Garden planner','Meal planner','Declutter checklist']},{type:'cta',title:'Get new resources',text:'New free tools, guides and practical downloads delivered as they are published.',button:'Explore new resources'} ] }
  ];
  const TB_RESOURCES = [
    ['🗓️','Weekly Reset Planner','A simple printable for priorities, appointments, meals and a calmer week.'],['🌱','Beginner Garden Checklist','Planning, soil, planting, watering and maintenance in one beginner-friendly checklist.'],['✓','Healthy Habit Tracker','A clean 30-day tracker for sleep, movement, hydration and personal habits.'],['👨‍👩‍👧','Family Routine Planner','Morning, school, evening and weekly family routines in one practical sheet.'],['🔧','Home Maintenance Checklist','Seasonal home checks organized into manageable tasks.'],['💼','Career Clarity Workbook','Prompts to compare strengths, values, role requirements and next steps.'],['📓','30-Day Mindfulness Journal','Short daily reflection prompts designed for busy adults.'],['🌼','Seasonal Garden Planner','A simple planning system for sowing, planting, maintenance and harvests.'],['🥗','Weekly Meal Planning Sheet','Meals, groceries and prep tasks organized on one page.'],['🧺','Room-by-Room Declutter List','A practical checklist for clearing common clutter without doing the whole house at once.']
  ];
  let tbWp = null, tbCurrent = null, tbPreviewTimer = null;
  const tbId = () => `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
  const tbBlank = () => ({ id:tbId(), name:'Untitled template', destination:'category', targetId:'', status:'publish', variant:'editorial', eyebrow:'', title:'', intro:'', hero:'', accent:'#2378d2', contentWidth:'1180', density:'balanced', radius:'20', fontPair:'modern', archiveMode:'full', showNativePosts:true, seo:{title:'',description:'',canonical:'',socialImage:'',schema:'CollectionPage',robots:'index,follow',breadcrumbs:true}, affiliates:[], blocks:[{type:'feature',title:'Featured story',text:'Add a short description for this section.'},{type:'grid',title:'Latest articles',items:['Article one','Article two','Article three']}] });
  function tbNormalize(x){ return { ...tbBlank(), ...(x||{}), id:x?.id||tbId(), blocks:Array.isArray(x?.blocks)?structuredClone(x.blocks):[], affiliates:Array.isArray(x?.affiliates)?structuredClone(x.affiliates):[] }; }
  function tbEnsure(){ ws.templates ||= []; if (!tbCurrent) tbCurrent = tbNormalize(ws.templates[0] || TB_PRESETS[0]); }
  const tbEsc = s => esc(String(s||''));
  function tbSlug(s){ return String(s||'').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g,'').trim().replace(/[\s_]+/g,'-').replace(/-+/g,'-').slice(0,90); }
  function tbDataFromForm(){
    if (!tbCurrent) tbEnsure();
    return { ...tbCurrent, name:$('#tbName').value.trim()||'Untitled template', destination:$('#tbDestination').value, targetId:$('#tbTarget').value, status:$('#tbStatus').value, variant:$('#tbVariant').value, eyebrow:$('#tbEyebrow').value.trim(), title:$('#tbTitle').value.trim(), intro:$('#tbIntro').value.trim(), hero:$('#tbHero').value.trim(), accent:$('#tbAccent').value, contentWidth:$('#tbContentWidth')?.value||'1180', density:$('#tbDensity')?.value||'balanced', radius:$('#tbRadius')?.value||'20', fontPair:$('#tbFontPair')?.value||'modern', archiveMode:$('#tbArchiveMode')?.value||'full', showNativePosts:($('#tbNativePosts')?.value||'yes')==='yes', seo:{title:$('#tbSeoTitle')?.value.trim()||'',description:$('#tbMetaDescription')?.value.trim()||'',canonical:$('#tbCanonical')?.value.trim()||'',socialImage:$('#tbSocialImage')?.value.trim()||'',schema:$('#tbSchema')?.value||'CollectionPage',robots:$('#tbRobots')?.value||'index,follow',breadcrumbs:$('#tbBreadcrumbs')?.checked!==false}, affiliates:tbCurrent.affiliates||[], blocks:tbCurrent.blocks||[] };
  }
  function tbDecodeText(v){ const el=document.createElement('textarea'); el.innerHTML=String(v??''); return el.value; }
  const TB_BLOCK_HELP={
    feature:'Lead with one important story, guide or offer. Best for a strong image, a short explanation and one clear next action.',
    topics:'Fast navigation chips that help readers jump into the subjects they care about. Add a URL after a | when a topic already has a destination.',
    grid:'Editorial article cards for related guides, latest posts or curated reading. Add optional descriptions to make each card feel intentional.',
    resources:'Download/resource cards for printables, planners, checklists and free guides. Use clear benefit-led titles and direct destinations.',
    list:'A clean numbered list for popular guides, recommended reading or priority links. Great for high-intent navigation.',
    steps:'A visual process for tutorials, roadmaps and “how to start” sections. Keep each step short and action oriented.',
    text:'Flexible editorial copy for introductions, explanations, trust sections and SEO-supporting content. Basic HTML is supported.',
    image:'A full visual moment with alt text and supporting copy. Useful between dense sections to improve pacing.',
    faq:'Expandable questions and answers. Write each line as Question | Answer. Useful for readers and structured content.',
    newsletter:'A focused subscription CTA with supporting copy and one destination button.',
    stats:'Proof or highlight cards for useful figures, quick facts or key takeaways.',
    quote:'A large editorial quote or reminder that breaks up the page and adds personality.',
    cta:'A high-contrast conversion banner for a next step, guide collection, product group or resource destination.',
    divider:'A subtle visual separator between major content groups.',
    spacer:'Adds intentional breathing room without adding visible content.'
  };
  function tbItem(v){
    const raw=String(v||'').trim(); if(!raw) return {title:'',url:'#',desc:''};
    const parts=raw.split('|').map(x=>x.trim()); const title=parts.shift()||''; let url='#',desc='';
    if(parts.length && (/^https?:\/\//i.test(parts[0])||parts[0].startsWith('/'))){ url=parts.shift(); desc=parts.join(' | ').trim(); }
    else desc=parts.join(' | ').trim();
    return {title,url,desc};
  }
  function tbBlockStyle(b){const st=[];if(b.background)st.push(`background:${tbEsc(b.background)}`);if(b.color)st.push(`color:${tbEsc(b.color)}`);return st.length?` style="${st.join(';')}"`:'';}
  function tbBlockHtml(b,i){
    const items=(b.items||[]).map(tbItem).filter(x=>x.title), wrap=`s section-${tbEsc(b.width||'content')} ${b.align==='center'?'center':''}`;
    if(b.type==='topics') return `<section class="${wrap}"${tbBlockStyle(b)}><h2>${tbEsc(b.title)}</h2><div class="pills">${items.map(x=>`<a href="${tbEsc(x.url)}"><span>${tbEsc(x.title)}</span></a>`).join('')}</div></section>`;
    if(['grid','resources','stats'].includes(b.type)) return `<section class="${wrap}"${tbBlockStyle(b)}><div class="section-heading"><span class="section-kicker">${b.type==='resources'?'TOOLS & DOWNLOADS':b.type==='stats'?'QUICK PROOF':'CURATED FOR YOU'}</span><h2>${tbEsc(b.title)}</h2>${b.text?`<p>${tbEsc(b.text)}</p>`:''}</div><div class="grid" style="--cols:${Number(b.columns)||3}">${items.map((x,n)=>`<article class="card"><div class="ph"><span>${b.type==='resources'?'FREE RESOURCE':b.type==='stats'?'HIGHLIGHT':String(n+1).padStart(2,'0')}</span></div><div class="card-copy"><h3>${tbEsc(x.title)}</h3>${x.desc?`<p>${tbEsc(x.desc)}</p>`:b.type==='stats'?'':`<p>${b.type==='resources'?'A ready-to-use resource designed to make the next step simpler.':'Practical guidance, clear ideas and useful next steps for this topic.'}</p>`}${x.url!=='#'?`<a class="card-link" href="${tbEsc(x.url)}">${b.type==='resources'?'Get resource':'Read guide'} <span>→</span></a>`:''}</div></article>`).join('')}</div></section>`;
    if(b.type==='list') return `<section class="${wrap}"${tbBlockStyle(b)}><div class="section-heading"><span class="section-kicker">POPULAR & USEFUL</span><h2>${tbEsc(b.title)}</h2></div><div class="rank">${items.map((x,n)=>`<div><b>${String(n+1).padStart(2,'0')}</b><div><a href="${tbEsc(x.url)}"><span>${tbEsc(x.title)}</span></a>${x.desc?`<small>${tbEsc(x.desc)}</small>`:''}</div><i>↗</i></div>`).join('')}</div></section>`;
    if(b.type==='steps') return `<section class="${wrap}"${tbBlockStyle(b)}><h2>${tbEsc(b.title)}</h2><div class="steps">${items.map((x,n)=>`<div><b>${n+1}</b><span>${tbEsc(x.title)}</span></div>`).join('')}</div></section>`;
    if(b.type==='text') return `<section class="${wrap} rich"${tbBlockStyle(b)}>${b.title?`<h2>${tbEsc(b.title)}</h2>`:''}<div>${b.text||''}</div></section>`;
    if(b.type==='image') return `<section class="${wrap} image-section"${tbBlockStyle(b)}>${b.title?`<h2>${tbEsc(b.title)}</h2>`:''}${b.image?`<img src="${tbEsc(b.image)}" alt="${tbEsc(b.alt||'')}">`:''}<p>${tbEsc(b.text||'')}</p></section>`;
    if(b.type==='faq') return `<section class="${wrap} faq"${tbBlockStyle(b)}><h2>${tbEsc(b.title)}</h2>${(b.items||[]).map(v=>{const [q,a='']=String(v).split('|',2);return `<details><summary>${tbEsc(q.trim())}</summary><p>${tbEsc(a.trim())}</p></details>`}).join('')}</section>`;
    if(b.type==='newsletter') return `<section class="newsletter"${tbBlockStyle(b)}><div><small>STAY IN THE LOOP</small><h2>${tbEsc(b.title)}</h2><p>${tbEsc(b.text)}</p></div><a href="${tbEsc(b.url||'#')}">${tbEsc(b.button||'Join / subscribe')}</a></section>`;
    if(b.type==='quote') return `<section class="quote"${tbBlockStyle(b)}>“${tbEsc(b.text||b.title)}”</section>`;
    if(b.type==='cta') return `<section class="cta"${tbBlockStyle(b)}><div><small>EXPLORE MORE</small><h2>${tbEsc(b.title)}</h2><p>${tbEsc(b.text)}</p></div><a href="${tbEsc(b.url||'#')}">${tbEsc(b.button||'Explore')}</a></section>`;
    if(b.type==='divider') return `<hr class="divider">`; if(b.type==='spacer') return `<div class="spacer"></div>`;
    return `<section class="feature">${b.image?`<div class="feature-img"><img src="${tbEsc(b.image)}" alt="${tbEsc(b.alt||'')}"></div>`:`<div class="feature-img"><span>EDITOR'S PICK</span></div>`}<div class="feature-copy"><small>FEATURED GUIDE</small><h2>${tbEsc(b.title)}</h2><p>${tbEsc(b.text)}</p>${b.url?`<a class="feature-link" href="${tbEsc(b.url)}">${tbEsc(b.button||'Read the guide')} <span>→</span></a>`:''}</div></section>`;
  }
  function tbAffiliatePreview(t){
    const rows=(t.affiliates||[]).filter(a=>a.title||a.url);
    if(!rows.length) return '';
    return `<aside class="aura-affiliates"><div class="aura-affiliate-sticky"><span class="aura-kicker">RECOMMENDED</span>${rows.map(a=>`<article class="aura-affiliate-card">${a.image?`<img src="${tbEsc(a.image)}" alt="">`:''}<small>${tbEsc(a.label||'Recommended')}</small><h3>${tbEsc(a.title)}</h3><p>${tbEsc(a.text)}</p><a href="#">${tbEsc(a.cta||'Learn more')} →</a><em>${tbEsc(a.disclosure||'Affiliate link')}</em></article>`).join('')}</div></aside>`;
  }
  function tbPublishedMarkup(t){
    const hero=t.hero?`--aura-accent:${tbEsc(t.accent||'#2378d2')};--aura-content:${tbEsc(t.contentWidth||'1180')}px;--aura-radius:${tbEsc(t.radius||'20')}px;--aura-hero:url('${String(t.hero).replace(/'/g,'%27')}')`:`--aura-accent:${tbEsc(t.accent||'#2378d2')};--aura-content:${tbEsc(t.contentWidth||'1180')}px;--aura-radius:${tbEsc(t.radius||'20')}px`;
    return `<div class="aura-site-shell aura-variant-${tbEsc(t.variant||'editorial')} aura-density-${tbEsc(t.density||'balanced')} aura-font-${tbEsc(t.fontPair||'modern')}" style="${hero}"><section class="aura-hero"><div class="aura-container"><span class="aura-kicker">${tbEsc(t.eyebrow)}</span><h1>${tbEsc(t.title||t.name)}</h1><p>${tbEsc(t.intro)}</p></div></section><div class="aura-layout"><main class="aura-main">${(t.blocks||[]).map(tbBlockHtml).join('')}</main>${tbAffiliatePreview(t)}</div></div>`;
  }
  function tbPreviewCss(){ return `<style>
  :root{--aura-ink:#122036;--aura-soft:#f4f8fb;--aura-line:#dce6ef}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:var(--aura-ink)}.aura-site-shell{--aura-accent:#2378d2;color:var(--aura-ink);font-family:Inter,Arial,sans-serif;background:#fff;line-height:1.65;overflow:hidden}.aura-site-shell a{color:inherit;text-decoration:none}.aura-container{width:min(var(--aura-content,1180px),calc(100% - 40px));margin:auto}.aura-hero{min-height:500px;display:grid;align-items:end;padding:86px 0 66px;position:relative;background:linear-gradient(90deg,#071a2ff2,#0c2944c7 58%,#0d1f3547),var(--aura-hero,linear-gradient(145deg,var(--aura-accent),#10263f));background-size:cover;background-position:center;color:#fff}.aura-hero:after{content:"";position:absolute;inset:auto -10% -45% 42%;height:340px;background:radial-gradient(circle,color-mix(in srgb,var(--aura-accent) 32%,transparent),transparent 65%);pointer-events:none}.aura-hero .aura-container{position:relative;z-index:1}.aura-kicker,.section-kicker{display:block;font-size:11px;font-weight:850;letter-spacing:.18em;text-transform:uppercase;color:var(--aura-accent)}.aura-hero .aura-kicker{display:inline-flex;padding:7px 11px;border:1px solid #ffffff38;border-radius:999px;background:#ffffff12;color:#d9ecff;backdrop-filter:blur(10px)}.aura-hero h1{max-width:940px;margin:14px 0 18px;font-size:clamp(42px,6vw,78px);line-height:.98;letter-spacing:-.055em}.aura-hero p{max-width:760px;margin:0;font-size:clamp(18px,2vw,21px);line-height:1.65;color:#e8f1f9}.aura-layout{width:min(calc(var(--aura-content,1180px) + 140px),calc(100% - 40px));margin:auto;display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:44px;padding:62px 0 92px}.aura-main{min-width:0}.aura-main .s{margin:0 0 64px}.aura-main h2{font-size:clamp(28px,3.3vw,44px);line-height:1.06;letter-spacing:-.04em;margin:7px 0 18px}.section-heading{margin-bottom:24px}.section-heading>p{max-width:760px;color:#607084}.pills{display:flex;flex-wrap:wrap;gap:11px}.pills a{display:block}.pills span{display:inline-flex;align-items:center;min-height:45px;border:1px solid #d5e2ec;padding:10px 16px;border-radius:999px;background:linear-gradient(180deg,#fff,#f7fafc);font-weight:750;box-shadow:0 7px 18px #18364e0b}.grid{display:grid;grid-template-columns:repeat(var(--cols,3),minmax(0,1fr));gap:18px}.card{min-width:0;overflow:hidden;border:1px solid var(--aura-line);border-radius:var(--aura-radius,20px);background:#fff;box-shadow:0 18px 48px #18364e0d}.card .ph{height:148px;margin:0;padding:16px;display:flex;align-items:flex-end;position:relative;background:radial-gradient(circle at 15% 20%,#ffffff2e,transparent 26%),linear-gradient(145deg,var(--aura-accent),#102845 72%);color:#fff}.card .ph:after{content:"";position:absolute;inset:18px 18px auto auto;width:44px;height:44px;border:1px solid #ffffff30;border-radius:50%}.card .ph span{font-size:10px;font-weight:850;letter-spacing:.14em}.card-copy{padding:20px}.card h3{font-size:21px;line-height:1.18;margin:0 0 9px}.card p{margin:0 0 15px;color:#647285;font-size:14px}.card-link,.feature-link{display:inline-flex;align-items:center;gap:7px;color:var(--aura-accent)!important;font-weight:800}.feature{display:grid;grid-template-columns:1.12fr 1fr;margin:10px 0 68px;border:1px solid var(--aura-line);border-radius:calc(var(--aura-radius,20px) + 6px);overflow:hidden;background:linear-gradient(145deg,#f8fbfd,#eef4f8);box-shadow:0 24px 70px #18364e0c}.feature-img{min-height:370px;display:flex;align-items:flex-end;padding:22px;background:radial-gradient(circle at 20% 18%,#ffffff30,transparent 26%),linear-gradient(145deg,var(--aura-accent),#102844)}.feature-img>span{color:#fff;font-size:10px;font-weight:850;letter-spacing:.16em}.feature-img img{width:100%;height:100%;object-fit:cover}.feature-copy{padding:46px}.feature small,.cta small{font-weight:850;letter-spacing:.15em;color:var(--aura-accent)}.feature p{color:#5f6e80}.rank{border-top:1px solid var(--aura-line)}.rank>div{display:grid;grid-template-columns:54px minmax(0,1fr) 26px;gap:12px;align-items:center;padding:20px 0;border-bottom:1px solid var(--aura-line)}.rank b{color:var(--aura-accent);font-size:12px;letter-spacing:.08em}.rank a span{font-size:19px;font-weight:760;color:var(--aura-ink)}.rank small{display:block;margin-top:4px;color:#718096;font-size:13px}.rank i{font-style:normal;color:#9bacbd}.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.steps>div{padding:20px;border:1px solid #e1e9f0;border-radius:var(--aura-radius,20px);background:linear-gradient(180deg,#fbfdff,#f2f6f9)}.steps b{display:grid;place-items:center;width:36px;height:36px;margin-bottom:14px;border-radius:12px;background:var(--aura-accent);color:#fff}.steps span{font-weight:750}.quote{margin:72px auto;padding:46px 6%;max-width:900px;text-align:center;font:600 clamp(30px,5vw,54px)/1.2 Georgia,serif;color:#233246}.cta{display:flex;justify-content:space-between;align-items:center;gap:30px;padding:36px;border-radius:var(--aura-radius,20px);background:radial-gradient(circle at 100% 0,#ffffff13,transparent 34%),linear-gradient(135deg,#071b33,#0d3157);color:#fff;box-shadow:0 22px 60px #0b244522}.cta h2{color:#fff}.cta p{color:#c2d0df}.cta a,.aura-affiliate-card a{display:inline-flex;padding:12px 17px;border-radius:999px;background:var(--aura-accent);color:#fff!important;font-weight:800}.aura-affiliate-sticky{position:sticky;top:24px;display:grid;gap:14px}.aura-affiliate-card{padding:17px;border:1px solid var(--aura-line);border-radius:var(--aura-radius,20px);background:#fff;box-shadow:0 14px 40px #18364e0a}.aura-affiliate-card img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:13px}.aura-affiliate-card em{display:block;margin-top:8px;font-size:10px;color:#8793a2;font-style:normal}.section-narrow{max-width:760px;margin-left:auto!important;margin-right:auto!important}.center{text-align:center}.image-section img{width:100%;max-height:620px;object-fit:cover;border-radius:var(--aura-radius,20px)}.faq details{border:1px solid var(--aura-line);border-radius:14px;padding:12px 16px;margin:9px 0;background:#fff}.newsletter{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:36px;border-radius:var(--aura-radius,20px);background:linear-gradient(135deg,#081d37,#0d3b69);color:#fff}.newsletter a{padding:12px 18px;border-radius:999px;background:var(--aura-accent);color:#fff!important;font-weight:800}.divider{border:0;border-top:1px solid var(--aura-line);margin:54px 0}.spacer{height:48px}.aura-density-compact .s{margin-bottom:42px}.aura-density-airy .s{margin-bottom:82px}.aura-font-editorial h1,.aura-font-editorial h2,.aura-font-editorial h3{font-family:Georgia,serif;letter-spacing:-.025em}.aura-variant-calm{background:#fcfdfd}.aura-variant-calm .aura-layout{padding-top:78px}.aura-variant-calm .card{box-shadow:none}.aura-variant-cards .card{border:0;box-shadow:0 18px 50px #18364e12}.aura-variant-cards .grid{gap:24px}.aura-variant-bold .aura-hero{min-height:590px}.aura-variant-bold .feature{background:#0d2139;color:#fff}.aura-variant-bold .feature h2{color:#fff}.aura-variant-bold .feature p{color:#c5d0dc}.aura-variant-editorial .feature{border-radius:4px}.aura-variant-editorial .card{border-radius:8px}@media(max-width:980px){.aura-layout{grid-template-columns:1fr}.aura-affiliate-sticky{position:static;grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.aura-container,.aura-layout{width:calc(100% - 28px)}.aura-hero{min-height:430px;padding:58px 0 42px}.aura-hero h1{font-size:clamp(38px,11vw,56px);line-height:1.01}.aura-hero p{font-size:18px}.aura-layout{padding:38px 0 62px;gap:28px}.aura-main .s{margin-bottom:48px}.grid,.aura-affiliate-sticky{grid-template-columns:1fr}.feature{grid-template-columns:1fr}.feature-img{min-height:230px}.feature-copy{padding:28px 22px}.steps{grid-template-columns:1fr 1fr}.cta,.newsletter{align-items:flex-start;flex-direction:column}.rank>div{grid-template-columns:42px minmax(0,1fr) 22px}.pills{gap:8px}.pills span{padding:9px 13px;min-height:40px;font-size:14px}}@media(max-width:430px){.steps{grid-template-columns:1fr}.aura-container,.aura-layout{width:calc(100% - 24px)}}
  </style>`; }
  function tbDocument(t, fragment=false){
    const inner=tbPublishedMarkup(t);
    if(fragment) return inner;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tbPreviewCss()}</head><body>${inner}</body></html>`;
  }
  function tbSetDevice(device){
    const p=$('.studio-preview'); p.classList.remove('phone','tablet');
    if(device==='mobile')p.classList.add('phone'); if(device==='tablet')p.classList.add('tablet');
    $('#tbDesk')?.classList.toggle('on',device==='desktop'); $('#tbTablet')?.classList.toggle('on',device==='tablet'); $('#tbPhone')?.classList.toggle('on',device==='mobile');
    if($('#tbPreviewDevice')) $('#tbPreviewDevice').value=device;
    $('#tbPreviewLabel').textContent=device==='mobile'?'Mobile 390':device==='tablet'?'Tablet 820':'Desktop 1440';
  }
  function tbPreview(){ clearTimeout(tbPreviewTimer); tbPreviewTimer=setTimeout(()=>{ const t=tbDataFromForm(); $('#tbPreview').srcdoc=tbDocument(t,false); if(typeof tbSeoAudit==='function')tbSeoAudit(); },100); }
  function tbRenderBlocks(){
    const icon={feature:'⭐',topics:'◉',grid:'▦',resources:'⬇',list:'☷',steps:'123',quote:'❝',cta:'↗',text:'¶',image:'▣',faq:'?',newsletter:'✉',stats:'%',divider:'—',spacer:'↕'};
    const options=[['feature','Feature'],['topics','Topic pills'],['grid','Article cards'],['resources','Resource cards'],['list','Ranked list'],['steps','Steps'],['text','Rich text'],['image','Image feature'],['faq','FAQ'],['newsletter','Newsletter CTA'],['stats','Stats / proof'],['quote','Quote'],['cta','CTA banner'],['divider','Divider'],['spacer','Spacer']];
    $('#tbBlocks').innerHTML=(tbCurrent.blocks||[]).map((b,i)=>`<details class="builder-block" ${i===0?'open':''} data-bi="${i}"><summary><span>${icon[b.type]||'◆'}</span><b>${tbEsc(b.title||'Untitled section')}</b><small>${tbEsc(b.type)}</small><span class="builder-block-tools"><button data-tb-up="${i}" title="Move up">↑</button><button data-tb-down="${i}" title="Move down">↓</button><button data-tb-del="${i}" title="Delete">×</button></span></summary><div class="builder-block-body">
      <div class="section-help span2"><b>${tbEsc(options.find(o=>o[0]===b.type)?.[1]||'Section')}</b><span>${tbEsc(TB_BLOCK_HELP[b.type]||'Build this section with content that supports the reader’s next step.')}</span></div>
      <label>Section type<select class="tb-b-type block-type">${options.map(o=>`<option value="${o[0]}" ${b.type===o[0]?'selected':''}>${o[1]}</option>`).join('')}</select></label>
      <label>Heading<input class="tb-b-title" value="${tbEsc(b.title||'')}"></label>
      ${['feature','quote','cta','text','image','newsletter'].includes(b.type)?`<label class="span2">Text / content<textarea class="tb-b-text" rows="4" placeholder="${b.type==='text'?'Basic HTML is supported: strong, em, links, lists.':''}">${tbEsc(b.text||'')}</textarea></label>`:''}
      ${['topics','grid','resources','list','steps','faq','stats'].includes(b.type)?`<label class="span2">Items — one per line <small>${b.type==='faq'?'Use Question | Answer':'Use Title | URL | optional description. You can also use Title | description when there is no link yet'}</small><textarea class="tb-b-items" rows="5">${tbEsc((b.items||[]).join('\n'))}</textarea></label>`:''}
      ${['feature','image'].includes(b.type)?`<label>Image URL<input class="tb-b-image" inputmode="url" value="${tbEsc(b.image||'')}" placeholder="https://..."></label><label>Image alt text<input class="tb-b-alt" value="${tbEsc(b.alt||'')}"></label>`:''}
      ${['feature','cta','newsletter'].includes(b.type)?`<label>Destination URL<input class="tb-b-url" inputmode="url" value="${tbEsc(b.url||'')}" placeholder="https://... or /page/"></label><label>Button label<input class="tb-b-button" value="${tbEsc(b.button||'Explore')}"></label>`:''}
      <label>Section width<select class="tb-b-width"><option value="full" ${b.width==='full'?'selected':''}>Full</option><option value="content" ${(!b.width||b.width==='content')?'selected':''}>Content</option><option value="narrow" ${b.width==='narrow'?'selected':''}>Narrow</option></select></label>
      <label>Alignment<select class="tb-b-align"><option value="left" ${(!b.align||b.align==='left')?'selected':''}>Left</option><option value="center" ${b.align==='center'?'selected':''}>Center</option></select></label>
      <label>Background<input class="tb-b-bg" value="${tbEsc(b.background||'')}" placeholder="#ffffff or linear-gradient(...)"></label>
      <label>Text color<input class="tb-b-color" value="${tbEsc(b.color||'')}" placeholder="#132238"></label>
      ${['grid','resources','stats'].includes(b.type)?`<label>Columns<select class="tb-b-columns"><option value="2" ${String(b.columns)==='2'?'selected':''}>2</option><option value="3" ${(!b.columns||String(b.columns)==='3')?'selected':''}>3</option><option value="4" ${String(b.columns)==='4'?'selected':''}>4</option></select></label>`:''}
    </div></details>`).join('') || '<p class="muted">No sections yet. Add one to start building.</p>';
    $$('.builder-block').forEach(el=>{
      const i=Number(el.dataset.bi); el.querySelectorAll('input,textarea,select').forEach(x=>x.addEventListener('input',()=>{ const b=tbCurrent.blocks[i];
        if(x.classList.contains('tb-b-type')){b.type=x.value;tbRenderBlocks();return;} if(x.classList.contains('tb-b-title'))b.title=x.value;if(x.classList.contains('tb-b-text'))b.text=x.value;if(x.classList.contains('tb-b-items'))b.items=x.value.split('\n').map(v=>v.trim()).filter(Boolean);if(x.classList.contains('tb-b-button'))b.button=x.value;if(x.classList.contains('tb-b-url'))b.url=x.value;if(x.classList.contains('tb-b-image'))b.image=x.value;if(x.classList.contains('tb-b-alt'))b.alt=x.value;if(x.classList.contains('tb-b-width'))b.width=x.value;if(x.classList.contains('tb-b-align'))b.align=x.value;if(x.classList.contains('tb-b-bg'))b.background=x.value;if(x.classList.contains('tb-b-color'))b.color=x.value;if(x.classList.contains('tb-b-columns'))b.columns=Number(x.value)||3;tbPreview(); }));
    });
    $$('[data-tb-up]').forEach(b=>b.onclick=e=>{e.preventDefault();const i=+b.dataset.tbUp;if(i>0){[tbCurrent.blocks[i-1],tbCurrent.blocks[i]]=[tbCurrent.blocks[i],tbCurrent.blocks[i-1]];tbRenderBlocks();tbPreview();}});
    $$('[data-tb-down]').forEach(b=>b.onclick=e=>{e.preventDefault();const i=+b.dataset.tbDown;if(i<tbCurrent.blocks.length-1){[tbCurrent.blocks[i+1],tbCurrent.blocks[i]]=[tbCurrent.blocks[i],tbCurrent.blocks[i+1]];tbRenderBlocks();tbPreview();}});
    $$('[data-tb-del]').forEach(b=>b.onclick=e=>{e.preventDefault();tbCurrent.blocks.splice(+b.dataset.tbDel,1);tbRenderBlocks();tbPreview();});
  }
  function tbRenderAffiliates(){
    const rows=tbCurrent.affiliates||[]; const root=$('#tbAffiliates'); if(!root)return;
    root.innerHTML=rows.length?rows.map((a,i)=>`<div class="affiliate-row" data-ai="${i}"><div class="affiliate-row-head"><b>Affiliate card ${i+1}</b><button data-aff-del="${i}" class="ghost danger">Remove</button></div><label>Label<input class="aff-label" value="${tbEsc(a.label||'Recommended')}"></label><label>Title<input class="aff-title" value="${tbEsc(a.title||'')}"></label><label class="span2">Description<textarea class="aff-text" rows="2">${tbEsc(a.text||'')}</textarea></label><label>Affiliate URL<input class="aff-url" inputmode="url" value="${tbEsc(a.url||'')}"></label><label>Image URL<input class="aff-image" inputmode="url" value="${tbEsc(a.image||'')}"></label><label>Button<input class="aff-cta" value="${tbEsc(a.cta||'Learn more')}"></label><label>Disclosure<input class="aff-disclosure" value="${tbEsc(a.disclosure||'Affiliate link')}"></label><div class="affiliate-preview"><i>Sticky on desktop · inline on mobile</i><span>${tbEsc(a.title||'Add a product or resource')}</span></div></div>`).join(''):`<div class="affiliate-empty">No side affiliate cards yet. Add one when a recommendation genuinely fits the page.</div>`;
    $$('.affiliate-row').forEach(el=>{const i=+el.dataset.ai; el.querySelectorAll('input,textarea').forEach(x=>x.addEventListener('input',()=>{const a=tbCurrent.affiliates[i];if(x.classList.contains('aff-label'))a.label=x.value;if(x.classList.contains('aff-title'))a.title=x.value;if(x.classList.contains('aff-text'))a.text=x.value;if(x.classList.contains('aff-url'))a.url=x.value;if(x.classList.contains('aff-image'))a.image=x.value;if(x.classList.contains('aff-cta'))a.cta=x.value;if(x.classList.contains('aff-disclosure'))a.disclosure=x.value;tbPreview();}));});
    $$('[data-aff-del]').forEach(b=>b.onclick=()=>{tbCurrent.affiliates.splice(+b.dataset.affDel,1);tbRenderAffiliates();tbPreview();});
  }
  function tbBridgeUi(){
    const installed=!!(tbWp?.bridge?.installed||tbWp?.bridge?.ok); const badge=$('#tbBridgeStatus'); if(!badge)return;
    badge.textContent=installed?`Active · v${tbWp.bridge.version||'1.0'}`:'Plugin required'; badge.className=`bridge-status ${installed?'ok':'bad'}`;
    $('#tbBridgeText').textContent=installed?(tbWp.support?.note||'Aura Site Bridge is active.'):'Install and activate Aura Site Bridge in WordPress → Plugins → Add New → Upload Plugin. Then refresh WordPress here. This fixes raw CSS and enables full archive takeovers.';
  }
  function tbSeoAudit(){const t=tbDataFromForm(),s=t.seo||{},checks=[];let score=0;const add=(ok,label,w)=>{if(ok)score+=w;checks.push([ok,label]);};add((s.title||'').length>=35&&(s.title||'').length<=65,'SEO title length',20);add((s.description||'').length>=120&&(s.description||'').length<=165,'Meta description',20);add(!!(t.title||'').trim(),'Visible H1',15);add(!!t.hero,'Hero image',10);add((t.blocks||[]).length>=3,'Content depth',10);add((t.blocks||[]).some(b=>['faq','steps','grid','resources'].includes(b.type)),'Useful structured section',10);add(!!s.canonical,'Canonical',5);add(!!s.socialImage||!!t.hero,'Social image',5);add((t.affiliates||[]).every(a=>!a.url||/^https?:\/\//i.test(a.url)),'Affiliate links valid',5);const el=$('#tbSeoScore');if(el){el.textContent=`SEO ${score}/100`;el.className=`seo-score ${score>=85?'good':score>=60?'mid':'low'}`;}if($('#tbSeoChecks'))$('#tbSeoChecks').innerHTML=checks.map(c=>`<span class="${c[0]?'ok':''}">${c[0]?'✓':'○'} ${tbEsc(c[1])}</span>`).join('');if($('#tbSeoTitleCount'))$('#tbSeoTitleCount').textContent=`${(s.title||'').length} / 60 recommended`;if($('#tbMetaCount'))$('#tbMetaCount').textContent=`${(s.description||'').length} / 160 recommended`;return score;}
  function tbFillForm(){ tbEnsure(); const se=tbCurrent.seo||{}; $('#tbName').value=tbCurrent.name||'';$('#tbDestination').value=tbCurrent.destination||'category';$('#tbStatus').value=tbCurrent.status||'publish';$('#tbVariant').value=tbCurrent.variant||'editorial';$('#tbEyebrow').value=tbCurrent.eyebrow||'';$('#tbTitle').value=tbCurrent.title||'';$('#tbIntro').value=tbCurrent.intro||'';$('#tbHero').value=tbCurrent.hero||'';$('#tbAccent').value=tbCurrent.accent||'#2378d2';if($('#tbContentWidth'))$('#tbContentWidth').value=String(tbCurrent.contentWidth||'1180');if($('#tbDensity'))$('#tbDensity').value=tbCurrent.density||'balanced';if($('#tbRadius'))$('#tbRadius').value=String(tbCurrent.radius||'20');if($('#tbFontPair'))$('#tbFontPair').value=tbCurrent.fontPair||'modern';if($('#tbSeoTitle'))$('#tbSeoTitle').value=se.title||'';if($('#tbMetaDescription'))$('#tbMetaDescription').value=se.description||'';if($('#tbCanonical'))$('#tbCanonical').value=se.canonical||'';if($('#tbSocialImage'))$('#tbSocialImage').value=se.socialImage||'';if($('#tbSchema'))$('#tbSchema').value=se.schema||'CollectionPage';if($('#tbRobots'))$('#tbRobots').value=se.robots||'index,follow';if($('#tbBreadcrumbs'))$('#tbBreadcrumbs').checked=se.breadcrumbs!==false;if($('#tbArchiveMode'))$('#tbArchiveMode').value=tbCurrent.archiveMode||'full';if($('#tbNativePosts'))$('#tbNativePosts').value=tbCurrent.showNativePosts===false?'no':'yes';tbPopulateTargets();tbRenderBlocks();tbRenderAffiliates();tbPreview();tbRenderSaved();tbBridgeUi();tbSeoAudit(); }
  function tbRenderSaved(){ $('#tbSavedCount').textContent=ws.templates?.length||0; $('#tbSaved').innerHTML=(ws.templates||[]).map(t=>`<button class="template-chip ${tbCurrent?.id===t.id?'on':''}" data-tb-load="${tbEsc(t.id)}"><span><b>${tbEsc(t.name)}</b><small>${tbEsc(t.destination)} · ${t.blocks?.length||0} sections</small></span><i>›</i></button>`).join('')||'<p class="hint">Save a design and it will stay here.</p>'; $$('[data-tb-load]').forEach(b=>b.onclick=()=>{const t=ws.templates.find(x=>x.id===b.dataset.tbLoad);if(t){tbCurrent=tbNormalize(t);tbFillForm();}}); }
  function tbRenderPresets(){ $('#tbPresets').innerHTML=TB_PRESETS.map(p=>`<button class="preset-card" data-tb-preset="${p.id}"><em>${p.icon}</em><b>${tbEsc(p.name)}</b><small>${p.blocks.length} ready sections</small></button>`).join(''); $$('[data-tb-preset]').forEach(b=>b.onclick=()=>{const p=TB_PRESETS.find(x=>x.id===b.dataset.tbPreset);tbCurrent=tbNormalize({...p,id:tbId()});tbFillForm();toast(`${p.name} loaded. Customize anything you want.`,'ok');}); }
  function tbRenderResources(){ $('#tbResourceSeeds').innerHTML=TB_RESOURCES.map((r,i)=>`<button class="resource-seed" data-tb-res="${i}"><span>${r[0]}</span><b>${tbEsc(r[1])}</b><small>${tbEsc(r[2])}</small></button>`).join(''); $$('[data-tb-res]').forEach(b=>b.onclick=()=>{const r=TB_RESOURCES[+b.dataset.tbRes];tbCurrent.blocks.push({type:'resources',title:r[1],items:[r[1]]});tbRenderBlocks();tbPreview();toast(`${r[1]} added to this template.`,'ok');}); }
  function tbPopulateTargets(){
    const d=$('#tbDestination').value, cur=String(tbCurrent?.targetId||''); let opts=[];
    if(!tbWp){ $('#tbTarget').innerHTML='<option value="">Refresh WordPress first</option>'; return; }
    if(d==='category') opts=(tbWp.categories||[]).map(x=>[x.id,tbDecodeText(x.name||x.slug||'Untitled category')]);
    else if(d==='page') opts=[['','Create a new page'],...(tbWp.pages||[]).map(x=>[x.id,tbDecodeText(x.title?.rendered||x.slug||'Untitled page')])];
    else if(d==='resource') opts=[['','Create a new resource post'],...(tbWp.categories||[]).map(x=>[`cat:${x.id}`,tbDecodeText(x.name||x.slug||'Untitled category')])];
    else opts=[['','Create a new post'],...(tbWp.categories||[]).map(x=>[`cat:${x.id}`,tbDecodeText(x.name||x.slug||'Untitled category')]),...(tbWp.posts||[]).map(x=>[x.id,tbDecodeText(x.title?.rendered||x.slug||'Untitled post')])];
    $('#tbTarget').innerHTML=opts.map(([v,n])=>`<option value="${tbEsc(v)}" ${String(v)===cur?'selected':''}>${tbEsc(n)}</option>`).join('');
    if (!cur && tbCurrent?.targetSlug) {
      let hit = null;
      if (d === 'category') hit = (tbWp.categories || []).find(x => x.slug === tbCurrent.targetSlug);
      if (d === 'page') hit = (tbWp.pages || []).find(x => x.slug === tbCurrent.targetSlug) || (tbWp.pages || []).find(x => String(x.title?.rendered||'').toLowerCase() === String(tbCurrent.title||'').toLowerCase());
      if (hit) { $('#tbTarget').value = String(hit.id); tbCurrent.targetId = String(hit.id); }
    }
    $('#tbDestHint').textContent=d==='category'?(tbWp.support?.note||'Install Aura Site Bridge for full archive control.'):(d==='page'?'Create a new landing page or replace an existing page. Aura Site Bridge supplies the polished responsive stylesheet.':d==='resource'?'Creates a downloadable resource post. Choose a category here or Aura will create/use “Resources”.':'Create a special-format post or update an existing one.');
  }
  async function tbRefreshWp(){ if(!hasWp()) return toast('Connect WordPress first.','warn'); $('#tbRefreshWp').disabled=true;$('#tbRefreshWp').textContent='Loading…';try{tbWp=await api('/api/wp/structure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wordpress:S.wp})});tbPopulateTargets();tbBridgeUi();toast(`Loaded ${tbWp.categories.length} categories and ${tbWp.pages.length} pages${tbWp.bridge?.installed?' · Aura Bridge active':''}.`,'ok');}catch(e){toast(e.message,'bad');}finally{$('#tbRefreshWp').disabled=false;$('#tbRefreshWp').textContent='↻ Refresh WordPress';} }
  async function tbCheckBridge(){ if(!hasWp())return toast('Connect WordPress first.','warn'); $('#tbBridgeCheck').disabled=true;try{const j=await api('/api/wp/bridge/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wordpress:S.wp})}); if(!tbWp)tbWp={categories:[],pages:[],posts:[],support:{}};tbWp.bridge={installed:true,...j.status};tbBridgeUi();const d=j.diagnostics;$('#tbBridgeText').textContent=d?`Bridge active · WordPress ${d.wordpress} · PHP ${d.php} · ${d.theme} ${d.theme_version}. Full archive control and responsive affiliate sidebars are ready.`:'Aura Site Bridge is active and ready.';toast('Aura Site Bridge is active.','ok');}catch(e){if(!tbWp)tbWp={categories:[],pages:[],posts:[],support:{}};tbWp.bridge={installed:false};tbBridgeUi();toast(e.message,'warn');}finally{$('#tbBridgeCheck').disabled=false;} }
  function tbInit(){
    tbEnsure(); tbRenderPresets();tbRenderResources();tbFillForm();tbSetDevice('desktop');
    ['tbName','tbVariant','tbEyebrow','tbTitle','tbIntro','tbHero','tbAccent','tbContentWidth','tbDensity','tbRadius','tbFontPair','tbSeoTitle','tbMetaDescription','tbCanonical','tbSocialImage','tbSchema','tbRobots','tbBreadcrumbs'].forEach(id=>$('#'+id)?.addEventListener('input',()=>{tbCurrent=tbDataFromForm();tbPreview();tbSeoAudit();}));
    $('#tbDestination').onchange=()=>{tbCurrent.destination=$('#tbDestination').value;tbCurrent.targetId='';tbPopulateTargets();tbPreview();}; $('#tbTarget').onchange=()=>tbCurrent.targetId=$('#tbTarget').value; $('#tbStatus').onchange=()=>tbCurrent.status=$('#tbStatus').value;
    $('#tbArchiveMode').onchange=()=>{tbCurrent.archiveMode=$('#tbArchiveMode').value;tbPreview();}; $('#tbNativePosts').onchange=()=>tbCurrent.showNativePosts=$('#tbNativePosts').value==='yes';
    $('#tbPreviewDevice').onchange=()=>tbSetDevice($('#tbPreviewDevice').value); $('#tbDesk').onclick=()=>tbSetDevice('desktop'); $('#tbTablet').onclick=()=>tbSetDevice('tablet'); $('#tbPhone').onclick=()=>tbSetDevice('mobile');
    $('#tbAddAffiliate').onclick=()=>{tbCurrent.affiliates.push({label:'Recommended',title:'',text:'',url:'',image:'',cta:'Learn more',disclosure:'Affiliate link'});tbRenderAffiliates();tbPreview();};
    $('#tbImportAffiliates').onclick=()=>{const src=(S.ads||[]).filter(a=>a.enabled!==false && a.url);if(!src.length)return toast('Your affiliate library has no enabled links yet. Add them under Standard & ads first.','warn');const known=new Set((tbCurrent.affiliates||[]).map(a=>a.url));for(const a of src){if(known.has(a.url))continue;tbCurrent.affiliates.push({label:a.label||S.adLabel||'Recommended',title:a.headline||a.title||a.label||'Recommended resource',text:a.text||a.description||'',url:a.url,image:a.image||'',cta:a.cta||'Learn more',disclosure:'Affiliate link'});}tbRenderAffiliates();tbPreview();toast('Affiliate library added to this template.','ok');};
    $('#tbAddBlock').onclick=()=>{tbCurrent.blocks.push({type:'feature',title:'New section',text:'Describe what this section should help the reader do.'});tbRenderBlocks();tbPreview();};
    $('#tbNew').onclick=()=>{tbCurrent=tbBlank();tbFillForm();}; $('#tbDuplicate').onclick=()=>{tbCurrent=tbNormalize({...tbDataFromForm(),id:tbId(),name:(tbDataFromForm().name||'Template')+' copy'});tbFillForm();};
    $('#tbSave').onclick=async()=>{tbCurrent=tbDataFromForm();const i=ws.templates.findIndex(x=>x.id===tbCurrent.id);if(i>=0)ws.templates[i]=structuredClone(tbCurrent);else ws.templates.unshift(structuredClone(tbCurrent));await saveWs();tbRenderSaved();updateDetails();toast('Template saved to Aura.','ok');};
    $('#tbRefreshWp').onclick=tbRefreshWp; $('#tbBridgeCheck').onclick=tbCheckBridge;
    $('#tbPreviewFull').onclick=()=>{const w=open('','_blank');if(!w)return toast('Allow pop-ups to open the large preview.','warn');w.document.write(tbDocument(tbDataFromForm(),false));w.document.close();};
    $('#tbPublish').onclick=async()=>{ if(!hasWp())return toast('Connect WordPress first.','warn');const t=tbDataFromForm();if(t.destination==='category' && !tbWp?.bridge?.installed)return toast('Install and activate Aura Site Bridge first. That is what prevents CSS from appearing as text and gives Aura full control of the category archive.','warn',9000);let target=t.targetId,categoryId=0;if(String(target).startsWith('cat:')){categoryId=Number(String(target).slice(4));target='';} $('#tbPublish').disabled=true;$('#tbPublishState').textContent='Publishing through WordPress…';try{const j=await api('/api/wp/template/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wordpress:S.wp,template:{...t,targetId:target,categoryId,title:t.title||t.name,slug:tbSlug(t.title||t.name),excerpt:t.intro,html:tbDocument(t,true)}})});$('#tbPublishState').innerHTML=`Published successfully${j.link?` · <a href="${tbEsc(j.link)}" target="_blank" rel="noopener">Open on WordPress ↗</a>`:''}${j.note?`<br><small>${tbEsc(j.note)}</small>`:''}`;toast(j.updated?'WordPress template updated.':'WordPress template published.','ok');await tbRefreshWp();}catch(e){ $('#tbPublishState').textContent=e.message;toast(e.message,'bad');}finally{$('#tbPublish').disabled=false;} };
    $('#tbUploadResource').onclick=async()=>{const f=$('#tbResourceFile').files[0],title=$('#tbResourceTitle').value.trim();if(!f)return toast('Choose a resource file.','warn');if(!title)return toast('Give the resource a title.','warn');if(!hasWp())return toast('Connect WordPress first.','warn');const fd=new FormData();fd.append('wordpress',JSON.stringify(S.wp));fd.append('meta',JSON.stringify({title,description:$('#tbResourceDesc').value.trim(),status:$('#tbStatus').value}));fd.append('file',f,f.name);$('#tbUploadResource').disabled=true;$('#tbResourceState').textContent='Uploading…';try{const j=await api('/api/wp/resource/upload',{method:'POST',body:fd});$('#tbResourceState').innerHTML=`Created · <a href="${tbEsc(j.post.link)}" target="_blank" rel="noopener">open resource ↗</a>`;toast('Resource uploaded and resource post created.','ok');}catch(e){$('#tbResourceState').textContent=e.message;toast(e.message,'bad');}finally{$('#tbUploadResource').disabled=false;}};
    if(hasWp()) tbRefreshWp();
  }

  // ---------- account ----------
  meter($('#aNew'), $('#aMeter'), $('#aHint'));
  $('#changePw').onclick = async () => {
    const m = $('#aMsg');
    if ($('#aNew').value !== $('#aNew2').value) { m.textContent = 'New passwords do not match.'; m.className = 'msg bad'; return; }
    try { await V.changePassword($('#aCur').value, $('#aNew').value); m.textContent = 'Password changed.'; m.className = 'msg ok'; $('#aCur').value = $('#aNew').value = $('#aNew2').value = ''; }
    catch (e) { m.textContent = e.message; m.className = 'msg bad'; }
  };
  $('#exportAcct').onclick = () => download(`aura-account-${uid}.json`, JSON.stringify(V.exportRecord(), null, 2));
  $('#exportQueue').onclick = () => download(`aura-queue-${uid}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), posts: ws.posts.map(({ source, ...p }) => p) }, null, 2));
  $('#autoLock').onchange = async () => { S.autoLockMin = Number($('#autoLock').value); await V.save(S); };
  $('#deleteAcct').onclick = async () => {
    const name = V.current()?.username;
    if (prompt(`Type "${name}" to delete this account from this device.`) !== name) return;
    const u = uid; await assetClearUser(u).catch(() => {}); await deleteWs(u).catch(() => {}); V.remove(name); lockUi(); toast('Account deleted.');
  };

  // ---------- tabs ----------
  function switchTab(id) {
    $$('.tabs button').forEach(b => { const on = b.dataset.tab === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); if (on) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); });
    $$('.tab').forEach(t => t.classList.toggle('on', t.id === id)); window.scrollTo({ top: 0 });
  }
  $$('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  document.addEventListener('click', e => { const go = e.target.closest('[data-go]'); if (go && S) { e.preventDefault(); switchTab(go.dataset.go); } });

  // Live detail lines under each menu bubble + the "not connected" banner.
  const hasWp = () => !!(S?.wp?.url && S.wp.username && S.wp.appPassword);
  function updateDetails() {
    if (!S) return;
    const ps = ws.posts, ready = ps.filter(p => p.validation?.ok).length, live = ps.filter(p => p.wp?.id).length;
    $('#tdQueue').textContent = ps.length ? `${ps.length} post${ps.length > 1 ? 's' : ''} · ${ready} ready${live ? ` · ${live} live` : ''}` : 'No posts yet';
    const ads = (S.ads || []).filter(a => a.enabled !== false && (a.url || a.html)).length;
    $('#tdStandard').textContent = `${ads} ad${ads === 1 ? '' : 's'} · ${S.standard.enforce ? 'standard on' : 'standard off'}`;
    const plx = window.AuraPrompt.plan({ ...S.prompt, ads: [] });
    $('#tdPrompt').textContent = plx.topics.length ? `${plx.topics.length} posts · ${plx.batches.length} batches` : `${S.prompt.batchSize || 3} posts per batch`;
    if ($('#tdBuilder')) $('#tdBuilder').textContent = `${ws.templates?.length || 0} saved · category, page, resources`;
    let host = ''; try { host = hasWp() ? new URL(S.wp.url).hostname : ''; } catch { host = S.wp.url; }
    $('#tdConn').textContent = hasWp() ? host : 'WordPress not added';
    $('#tdConn').classList.toggle('warn', !hasWp());
    const rec = V.current()?.hasRecovery;
    $('#tdAcct').textContent = `${V.current()?.username} · ${rec ? 'reset key saved' : 'no reset key yet'}`;
    $('#tdAcct').classList.toggle('warn', !rec);
    $('#wpBanner').hidden = hasWp();
  }

  // ---------- lock screen ----------
  function lockTab(id) { $$('[data-lock]').forEach(b => b.classList.toggle('on', b.dataset.lock === id)); $$('.lockform').forEach(f => f.classList.toggle('on', f.id === 'f' + id[0].toUpperCase() + id.slice(1))); }
  $$('[data-lock]').forEach(b => b.onclick = () => lockTab(b.dataset.lock));
  function refreshUsers() { const us = V.list(); $('#userList').innerHTML = us.map(u => `<option value="${esc(u.username)}">`).join(''); if (us.length === 1 && !$('#uUser').value) $('#uUser').value = us[0].username; if (!us.length) lockTab('create'); }
  meter($('#cPass'), $('#cMeter'), $('#cHint'), '#cUser');
  meter($('#rPass'), $('#rMeter'), $('#rHint'), '#rUser');
  const setMsg = (el, t, cls = 'bad') => { el.textContent = t; el.className = `msg ${cls}`; };

  $('#fUnlock').onsubmit = async e => {
    e.preventDefault(); const m = $('#uMsg'); setMsg(m, 'Unlocking…', 'muted');
    try { await V.unlock($('#uUser').value, $('#uPass').value); $('#uPass').value = ''; setMsg(m, ''); enterApp(); }
    catch (err) { setMsg(m, err.message); }
  };
  $('#fCreate').onsubmit = async e => {
    e.preventDefault(); const m = $('#cMsg');
    if ($('#cPass').value !== $('#cPass2').value) return setMsg(m, 'Passwords do not match.');
    const st = V.strength($('#cPass').value, $('#cUser').value); if (!st.ok) return setMsg(m, 'Password needs ' + st.issues.join(', ') + '.');
    if (V.exists($('#cUser').value)) return setMsg(m, 'That username already exists on this device.');
    const w = { url: $('#cUrl').value.trim(), username: $('#cWpUser').value.trim(), appPassword: $('#cWpPass').value.trim() };
    const filled = [w.url, w.username, w.appPassword].filter(Boolean).length;
    if (filled && filled < 3) return setMsg(m, 'Fill in all three WordPress fields, or leave all three empty and add them later in Connections.');
    if (filled) {
      // Only contact the engine when there is a connection to verify, so skipping it costs no requests.
      setMsg(m, 'Checking your WordPress login…', 'muted');
      try { const j = await testWp(w); w.url = j.site || w.url; setMsg(m, `WordPress verified as ${j.user?.name}. Encrypting your account…`, 'ok'); }
      catch (err) {
        if (err.status) return setMsg(m, err.message); // WordPress said no: the recovery key must be correct
        if (!confirm('Aura Engine is not reachable right now, so your WordPress login could not be verified. Create the account anyway? (Your Application Password becomes your recovery key, so make sure it is correct.)')) return setMsg(m, 'Not created. Try again when the engine is online.');
      }
    } else if (!confirm('Create the account without WordPress for now?\n\nYou can import, preview and generate images right away. Until you add your Application Password in Connections, a forgotten Aura password cannot be reset.')) return setMsg(m, '', 'muted');
    try {
      const settings = merge(DEFAULTS, { wp: w });
      await V.create($('#cUser').value, $('#cPass').value, settings);
      $('#cPass').value = $('#cPass2').value = $('#cWpPass').value = ''; setMsg(m, '');
      enterApp(); toast(filled ? 'Account created. Your WordPress login is saved and encrypted.' : 'Account created. Add WordPress in Connections whenever you are ready.', 'ok');
    } catch (err) { setMsg(m, err.message); }
  };
  $('#fReset').onsubmit = async e => {
    e.preventDefault(); const m = $('#rMsg');
    if ($('#rPass').value !== $('#rPass2').value) return setMsg(m, 'New passwords do not match.');
    setMsg(m, 'Verifying…', 'muted');
    try { await V.recover($('#rUser').value, $('#rApp').value, $('#rPass').value); $('#rApp').value = $('#rPass').value = $('#rPass2').value = ''; setMsg(m, ''); enterApp(); toast('Password reset. You are signed in.', 'ok'); }
    catch (err) { setMsg(m, err.message); }
  };
  $('#rDelete').onclick = async () => {
    const name = $('#rUser').value.trim();
    if (!name || !V.exists(name)) return setMsg($('#rMsg'), 'Enter the username of the account to delete.');
    if (prompt(`This permanently deletes "${name}", its queue and images on this device. Type the username to confirm.`) !== name) return;
    const rec = V.list().find(x => x.username === name); const delUid = rec?.uid || name.toLowerCase(); await assetClearUser(delUid).catch(() => {}); await deleteWs(delUid).catch(() => {}); V.remove(name); refreshUsers(); lockTab('create'); toast('Account deleted. Create a new one.');
  };
  $('#restoreBtn').onclick = () => $('#restoreFile').click();
  $('#restoreFile').onchange = async () => {
    const f = $('#restoreFile').files[0]; if (!f) return;
    try { let obj = JSON.parse(await f.text()), name; try { name = V.importRecord(obj); } catch (e) { if (/already exists/.test(e.message) && confirm(e.message + ' Replace it with the backup?')) name = V.importRecord(obj, true); else throw e; } refreshUsers(); $('#uUser').value = name; lockTab('unlock'); toast(`Restored "${name}". Unlock with its password.`, 'ok'); }
    catch (e) { toast(e.message, 'bad'); } finally { $('#restoreFile').value = ''; }
  };

  // ---------- session lifecycle ----------
  let idleTimer;
  function bumpIdle() { clearTimeout(idleTimer); if (!S) return; idleTimer = setTimeout(() => { lockUi(); toast('Locked after inactivity.'); }, (S.autoLockMin || 30) * 60000); }
  ['click', 'keydown', 'pointermove', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (S) { clearTimeout(bumpIdle.t); bumpIdle.t = setTimeout(bumpIdle, 1000); } }, { passive: true }));

  async function enterApp() {
    S = merge(DEFAULTS, V.settings()); uid = V.current().uid;
    // Ask the browser not to evict Aura's IndexedDB under storage pressure when supported.
    navigator.storage?.persist?.().catch(() => false);
    if (/^Photorealistic editorial photography, natural window light, authentic diverse real people/.test(S.standard.style || '')) S.standard.style = DEFAULTS.standard.style; // move old default to the new people-first style
    $('#who').textContent = V.current().username;
    $('#lock').hidden = true; $('#app').hidden = false;
    await loadWs(); fillStandard(); fillConnections(); tbInit();
    Object.entries(pFields).forEach(([id, k]) => $('#' + id).value = S.prompt[k] ?? '');
    buildPrompt();
    $('#bulkStatus').value = S.publish.status; $('#bulkGap').value = String(S.publish.gapDays || 0); $('#bulkStatus').onchange();
    $('#autoLock').value = String(S.autoLockMin || 30);
    await refreshPending().catch(() => {}); render(); genState(); bumpIdle();
    switchTab('queue');
    upgradeQueue().catch(e => log(`Queue upgrade skipped: ${e.message}`, 'warn')).finally(() => setTimeout(startPhotoWorker, 1500));
  }
  // One-time upgrade of posts imported by older versions: drop drawn placeholder images and rebuild photo direction.
  async function isPlaceholder(a) {
    try {
      const bmp = await createImageBitmap(b64blob(a)); const px = bmp.width * bmp.height; bmp.close?.();
      const bytes = a.dataBase64.length * 0.75, bpp = bytes / px;
      return px < 250000 || (/jpe?g/.test(a.mime || 'jpeg') ? bpp < 0.075 : /png/.test(a.mime || '') ? bpp < 0.3 : false);
    } catch { return false; }
  }
  async function upgradeQueue() {
    if (!ws.posts.length || !S) return;
    let dropped = 0;
    if (S.standard.rejectPlaceholders !== false && !ws.phScanned) {
      for (const p of ws.posts) for (const i of images(p)) { if (p.wp?.media?.[i.filename]) continue; const a = await assetGet(i.filename); if (a && await isPlaceholder(a)) { await assetDel(i.filename); dropped++; } }
      ws.phScanned = true; saveWs();
    }
    const stale = ws.posts.some(p => images(p).some(i => !i.render_prompt));
    if ((stale || dropped) && health.online !== false) {
      const j = await api('/api/standardize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: ws.posts.map(({ validation, pending, ...p }) => p), options: stdOptions(), assetNames: await assetKeys() }) });
      ws.posts = j.posts; rememberSigs(j.posts);
    }
    await refreshPending(); render();
    if (dropped) { log(`Removed ${dropped} drawn placeholder image${dropped > 1 ? 's' : ''}; real photos will be generated instead.`, 'ok'); toast(`${dropped} placeholder images will be replaced with real photos.`, 'ok'); }
  }
  function lockUi() {
    worker.on = false; worker.paused = false;
    V.lock(); S = null; uid = null; ws = { posts: [], templates: [], schemaVersion: 14 };
    clearTimeout(idleTimer); $('#app').hidden = true; $('#lock').hidden = false;
    $('#list').innerHTML = ''; $('#log').innerHTML = ''; ['#wpPass', '#oaKey', '#aCur', '#aNew', '#aNew2'].forEach(s => $(s).value = '');
    if ($('#preview').open) $('#preview').close();
    refreshUsers(); lockTab(V.list().length ? 'unlock' : 'create');
  }
  $('#signOutBtn').onclick = $('#signOut2').onclick = () => { lockUi(); toast('Signed out.'); };

  // ---------- engine health ----------
  async function wake() {
    $('#health').textContent = 'Waking engine…'; $('#health').className = 'pill';
    for (let i = 0; i < 24; i++) {
      try { const r = await fetch(API + '/healthz', { cache: 'no-store' }); if (r.ok) { health = { online: true, ...(await r.json()) }; $('#health').textContent = `Engine online · API ${health.version}`; $('#health').className = 'pill on'; if (S) { genState(); await refreshPending().catch(() => {}); render(); } return; } } catch {}
      await sleep(5000);
    }
    $('#health').textContent = 'Engine offline'; $('#health').className = 'pill off';
  }
  $('#health').onclick = wake;

  // Prefill create form from the old V10 connection, if present.
  $('#cUrl').value = localStorage.getItem('wp-url') || ''; $('#cWpUser').value = localStorage.getItem('wp-user') || '';
  if (!window.crypto?.subtle) { $('#uMsg').textContent = 'This browser cannot encrypt accounts. Open Aura over https in a current browser.'; }
  refreshUsers(); wake();
})();
