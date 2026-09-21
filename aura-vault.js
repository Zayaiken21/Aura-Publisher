// Aura Vault — per-user encrypted accounts stored on this device.
// Each account has a random 256-bit data key (DEK). The DEK is wrapped twice:
//   1) with a key derived (PBKDF2-SHA256, 310k iterations) from the Aura password
//   2) with a key derived from the WordPress Application Password (the recovery key)
// Settings (WordPress login, OpenAI key, ads…) are AES-GCM encrypted with the DEK.
// Password reset = prove you hold the original WordPress Application Password → unwrap DEK → set a new password.
(() => {
  const STORE = 'aura-accounts-v1';
  const ITER = 310000;
  const te = new TextEncoder(), td = new TextDecoder();
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const normRecovery = s => String(s || '').replace(/\s+/g, '');
  const uidOf = u => String(u || '').trim().toLowerCase();

  const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{"users":{}}'); } catch { return { users: {} }; } };
  const persist = db => localStorage.setItem(STORE, JSON.stringify(db));

  async function kek(secret, salt, iter = ITER) {
    const base = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(key, bytes, aad) { const iv = rand(12); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes)); return { iv: b64(iv), ct: b64(ct) }; }
  async function unseal(key, box, aad) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(box.iv), additionalData: te.encode(aad) }, key, ub64(box.ct))); }
  const dekKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  async function wrap(secret, dek, uid, purpose) {
    const salt = rand(16), k = await kek(secret, salt);
    return { salt: b64(salt), iter: ITER, box: await seal(k, dek, `aura:${uid}:${purpose}`) };
  }
  async function unwrap(secret, w, uid, purpose) {
    const k = await kek(secret, ub64(w.salt), w.iter || ITER);
    return unseal(k, w.box, `aura:${uid}:${purpose}`);
  }

  // ----- password policy -----
  const COMMON = ['password', '123456', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon', 'football', 'aura', 'wordpress'];
  function strength(pw, username = '') {
    pw = String(pw || '');
    const issues = [];
    if (pw.length < 12) issues.push('at least 12 characters');
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
    if (classes < 3) issues.push('3 of: lowercase, uppercase, number, symbol');
    const low = pw.toLowerCase();
    if (username && uidOf(username).length >= 3 && low.includes(uidOf(username))) issues.push('not containing your username');
    if (COMMON.some(c => low.includes(c))) issues.push('no common words like "password"');
    if (/(.)\1{3,}/.test(pw)) issues.push('no long repeated characters');
    let score = Math.min(4, Math.floor(pw.length / 5) + classes - 2 - issues.length);
    if (!pw) score = 0;
    return { ok: issues.length === 0, score: Math.max(0, score), issues };
  }

  // ----- lockout (slows guessing on this device; PBKDF2 cost is the main protection) -----
  function checkLock(rec) { const until = rec.fails?.until || 0; if (Date.now() < until) { const s = Math.ceil((until - Date.now()) / 1000); throw new Error(`Too many attempts. Try again in ${s >= 60 ? Math.ceil(s / 60) + ' min' : s + ' s'}.`); } }
  function noteFail(db, uid) { const r = db.users[uid]; const n = (r.fails?.n || 0) + 1; r.fails = { n, until: n >= 5 ? Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (n - 5)) : 0 }; persist(db); }
  function clearFails(db, uid) { db.users[uid].fails = { n: 0, until: 0 }; persist(db); }

  let session = null; // { uid, username, dek(Uint8Array), key(CryptoKey), settings }

  async function writeVault(db, uid, key, settings) { db.users[uid].vault = await seal(key, te.encode(JSON.stringify(settings)), `aura:${uid}:vault`); db.users[uid].updatedAt = Date.now(); persist(db); }

  const Vault = {
    strength,
    list() { return Object.values(load().users).map(u => ({ uid: uidOf(u.username), username: u.username, createdAt: u.createdAt })); },
    exists(username) { return !!load().users[uidOf(username)]; },
    current() { return session ? { uid: session.uid, username: session.username } : null; },
    settings() { return session ? structuredClone(session.settings) : null; },

    async create(username, password, settings) {
      const uid = uidOf(username);
      if (!/^[a-z0-9._-]{3,32}$/.test(uid)) throw new Error('Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
      const db = load();
      if (db.users[uid]) throw new Error('That username already exists on this device. Unlock it or choose another name.');
      const st = strength(password, username); if (!st.ok) throw new Error('Password needs ' + st.issues.join(', ') + '.');
      const recovery = normRecovery(settings?.wp?.appPassword);
      if (recovery.length < 16) throw new Error('Enter your WordPress Application Password. It is your recovery key for password resets.');
      const dek = rand(32);
      db.users[uid] = { v: 1, username: String(username).trim(), createdAt: Date.now(), pw: await wrap(password, dek, uid, 'pw'), rec: await wrap(recovery, dek, uid, 'rec'), fails: { n: 0, until: 0 } };
      const key = await dekKey(dek);
      await writeVault(db, uid, key, settings);
      session = { uid, username: db.users[uid].username, dek, key, settings: structuredClone(settings) };
      return this.current();
    },

    async unlock(username, password) {
      const uid = uidOf(username), db = load(), rec = db.users[uid];
      if (!rec) throw new Error('No account with that username on this device.');
      checkLock(rec);
      let dek;
      try { dek = await unwrap(password, rec.pw, uid, 'pw'); } catch { noteFail(db, uid); throw new Error('Wrong password.'); }
      clearFails(db, uid);
      const key = await dekKey(dek);
      const settings = JSON.parse(td.decode(await unseal(key, rec.vault, `aura:${uid}:vault`)));
      session = { uid, username: rec.username, dek, key, settings };
      return this.current();
    },

    async save(settings) {
      if (!session) throw new Error('Account is locked.');
      const db = load(), uid = session.uid;
      const oldRec = normRecovery(session.settings?.wp?.appPassword), newRec = normRecovery(settings?.wp?.appPassword);
      if (newRec && newRec !== oldRec) db.users[uid].rec = await wrap(newRec, session.dek, uid, 'rec'); // recovery key follows the current WP Application Password
      await writeVault(db, uid, session.key, settings);
      session.settings = structuredClone(settings);
    },

    async changePassword(current, next) {
      if (!session) throw new Error('Account is locked.');
      const db = load(), uid = session.uid, rec = db.users[uid];
      checkLock(rec);
      try { await unwrap(current, rec.pw, uid, 'pw'); } catch { noteFail(db, uid); throw new Error('Current password is wrong.'); }
      const st = strength(next, session.username); if (!st.ok) throw new Error('New password needs ' + st.issues.join(', ') + '.');
      if (current === next) throw new Error('Choose a password you have not used for this account.');
      rec.pw = await wrap(next, session.dek, uid, 'pw'); rec.fails = { n: 0, until: 0 }; persist(db);
    },

    // Reset with the WordPress Application Password that was saved in this account.
    async recover(username, appPassword, next) {
      const uid = uidOf(username), db = load(), rec = db.users[uid];
      if (!rec) throw new Error('No account with that username on this device.');
      checkLock(rec);
      let dek;
      try { dek = await unwrap(normRecovery(appPassword), rec.rec, uid, 'rec'); }
      catch { noteFail(db, uid); throw new Error('That Application Password does not match this account. Without it the account cannot be recovered — delete it and create a new one.'); }
      const st = strength(next, rec.username); if (!st.ok) throw new Error('New password needs ' + st.issues.join(', ') + '.');
      rec.pw = await wrap(next, dek, uid, 'pw'); rec.fails = { n: 0, until: 0 }; persist(db);
      const key = await dekKey(dek);
      const settings = JSON.parse(td.decode(await unseal(key, rec.vault, `aura:${uid}:vault`)));
      session = { uid, username: rec.username, dek, key, settings };
      return this.current();
    },

    remove(username) {
      const uid = uidOf(username), db = load();
      delete db.users[uid]; persist(db);
      localStorage.removeItem(`aura-ws:${uid}`);
      if (session?.uid === uid) session = null;
    },
    lock() { if (session) { session.dek.fill(0); session = null; } },

    // Encrypted backup (safe to store anywhere; needs the password to open)
    exportRecord() { if (!session) throw new Error('Account is locked.'); return { kind: 'aura-account-backup', v: 1, record: load().users[session.uid] }; },
    importRecord(obj, overwrite = false) {
      const r = obj?.record; if (obj?.kind !== 'aura-account-backup' || !r?.username || !r?.pw || !r?.vault) throw new Error('This is not an Aura account backup file.');
      const db = load(), uid = uidOf(r.username);
      if (db.users[uid] && !overwrite) throw new Error(`Account "${r.username}" already exists on this device.`);
      db.users[uid] = { ...r, fails: { n: 0, until: 0 } }; persist(db); return r.username;
    }
  };
  window.AuraVault = Vault;
})();
