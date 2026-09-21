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
  let ws = { posts: [], schemaVersion: 13 };
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
      try { const legacy = JSON.parse(localStorage.getItem(key) || 'null'); if (legacy?.posts) { ws = { ...legacy, schemaVersion: 13 }; await wsTx('readwrite', st => st.put({ key, value: ws })); localStorage.removeItem(key); return; } } catch {}
    }
    ws = rec?.value?.posts ? { ...rec.value, schemaVersion: 13 } : { posts: [], schemaVersion: 13 };
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
    await loadWs(); fillStandard(); fillConnections();
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
    V.lock(); S = null; uid = null; ws = { posts: [], schemaVersion: 13 };
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
