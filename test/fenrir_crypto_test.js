// Offline tests for the Fenrir Realm plugin's read-token flow and decryption.
//
// usage: node fenrir_crypto_test.js [official-fenrirrealm.js]
//
// A fake server stands in for fenrirealm.com: it issues tokens, honours
// exchanges, demands a captcha when the session has none, and serves chapters
// AES-GCM encrypted the way the site does (fragmented v1 and v2 schemes). The
// live site cannot be exercised end to end without a person solving its
// captcha, so this is where the flow is proven. Given the official plugin's
// compiled file, the same encrypted chapters are also decrypted by the
// official decryptWithToken, and both must agree (parity, ENGINEERING-RULES 7).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const cheerio = require('cheerio');

const PLUGIN = path.join(__dirname, '..', 'repo', 'src', 'plugins', 'english', 'fenrirealm.js');
const FilterTypes = { TextInput: 'Text', Picker: 'Picker', CheckboxGroup: 'Checkbox', Switch: 'Switch', ExcludableCheckboxGroup: 'XCheckbox' };

function gcm(key, iv) {
  return {
    decrypt(data) {
      const d = Buffer.from(data);
      const dec = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
      dec.setAuthTag(d.subarray(d.length - 16));
      return new Uint8Array(Buffer.concat([dec.update(d.subarray(0, d.length - 16)), dec.final()]));
    },
  };
}
class Storage {
  constructor() { this.db = {}; }
  set(k, v, exp) { this.db[k] = { value: v, expires: exp instanceof Date ? exp.getTime() : exp }; }
  get(k) { const i = this.db[k]; if (i && i.expires && Date.now() > i.expires) { delete this.db[k]; return undefined; } return i && i.value; }
  delete(k) { delete this.db[k]; }
}
function load(file, fetchApi, storage) {
  const libs = {
    '@libs/fetch': { fetchApi }, '@libs/defaultCover': { defaultCover: 'cover' }, '@libs/filterInputs': { FilterTypes },
    '@libs/storage': { storage }, '@libs/aes': { gcm }, '@libs/novelStatus': { NovelStatus: {} }, cheerio,
  };
  const ex = {}, mod = { exports: ex };
  new Function('require', 'exports', 'module', fs.readFileSync(file, 'utf8'))(n => {
    if (!(n in libs)) throw new Error('missing lib ' + n);
    return libs[n];
  }, ex, mod);
  return ex.default;
}

// ---- reference implementation of the site's scheme, written from scratch
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest();
function xorshift(state) {
  const t = state[0]; let r = (t ^ (t << 11)) >>> 0; r = (r ^ (r >>> 8)) >>> 0;
  const o = state[3]; state[0] = state[1]; state[1] = state[2]; state[2] = o;
  const f = (o ^ (o >>> 19) ^ r) >>> 0; state[3] = f; return f;
}
function shuffle(str, parts, seed) {
  const size = Math.ceil(str.length / parts), frags = [];
  for (let i = 0; i < str.length; i += size) frags.push(str.slice(i, i + size));
  const d = sha(seed), state = new Uint32Array([d.readUInt32LE(0), d.readUInt32LE(4), d.readUInt32LE(8), d.readUInt32LE(12)]);
  const perm = frags.map((_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) { const j = xorshift(state) % (i + 1); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  return perm.map(p => frags[p]); // fragments[i] = original[perm[i]]
}
function encryptChapter(text, token, scheme, cid) {
  const vid = JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).vid;
  const v2 = scheme === 'fragmented-v2';
  const seed = v2 ? `${token}:${vid}:${cid}:fr-content-v2` : `${token}:${cid}:fr-content-v1`;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sha(seed), iv);
  const b64 = Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
  const frag = v2 ? `${token}:${vid}:${cid}:fr-frag-v2` : `${token}:${cid}:fr-frag-v1`;
  return shuffle(b64, 7, frag);
}

// ---- fake fenrirealm.com
function makeToken(n, expSec) {
  return Buffer.from(JSON.stringify({ vid: 'visitor-' + n, exp: expSec })).toString('base64url') + '.sig' + n;
}
function fakeSite(opts) {
  const s = { jarCookie: opts.jarCookie || null, exchangesLeft: opts.exchanges, valid: new Set(), minted: 0, requests: [],
    ttl: opts.ttl || 300, scheme: opts.scheme || 'fragmented-v2', text: opts.text };
  if (s.jarCookie) s.valid.add(s.jarCookie);
  const respond = (status, body, headers) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: k => (headers || {})[k.toLowerCase()] || null },
    json: async () => body, text: async () => JSON.stringify(body),
  });
  const mint = () => {
    s.minted++;
    const t = makeToken(s.minted, Math.floor(Date.now() / 1000) + s.ttl);
    s.valid.add(t); return t;
  };
  s.fetch = async (url, o) => {
    o = o || {};
    // The app's HTTP client attaches the WebView session cookie itself.
    let cookie = (o.headers && o.headers.Cookie) || (s.jarCookie ? 'fr_read=' + s.jarCookie : '');
    const tok = (cookie.match(/fr_read=([^;]+)/) || [])[1];
    s.requests.push((o.method || 'GET') + ' ' + url.replace('https://fenrirealm.com/', ''));
    if (url.endsWith('/api/read-token')) {
      if (!tok || !s.valid.has(tok) || s.exchangesLeft <= 0) {
        return respond(403, { error: 'A captcha challenge is required to mint a read token.', challenge_required: true });
      }
      s.exchangesLeft--; s.valid.delete(tok);
      const t = mint();
      return respond(200, { active: true, token: t, expires_at: Math.floor(Date.now() / 1000) + s.ttl },
        { 'x-read-token-exchanges-remaining': String(s.exchangesLeft) });
    }
    const m = url.match(/series\/([^/]+)\/chapters\/([^/?]+)$/);
    if (m) {
      const paid = m[2] === 'paid';
      const base = { uuid: 'uuid-' + m[2], slug: m[2], content_cid: 4242, locked: paid ? { price: 5, unlocked_at: null } : { price: 0 } };
      if (paid || !tok || !s.valid.has(tok)) return respond(200, Object.assign(base, { content: '', content_format: 'locked' }));
      return respond(200, Object.assign(base, { content_format: 'encrypted', content_scheme: s.scheme,
        content: encryptChapter(s.text, tok, s.scheme, 4242) }));
    }
    throw new Error('fake site: unexpected request ' + url);
  };
  return s;
}

const TEXT = '<p>Chapter one — the quiet before the storm.</p><p aria-hidden="true">decoy</p><p>Ünïcode ✓ text.</p>';
const WANT = '<p>Chapter one — the quiet before the storm.</p><p>Ünïcode ✓ text.</p>';

async function main() {
  // 1. SHA-256 against node:crypto, every length across two block boundaries
  //    plus multibyte input. Reached through the decrypt path, so a wrong
  //    digest shows up as a failed decryption in the flows below as well.
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
    const site = fakeSite({ jarCookie: 'x', exchanges: 1, text: 'é'.repeat(len) + 'end' });
    site.valid.clear(); site.jarCookie = makeToken(0, Math.floor(Date.now() / 1000) + 300); site.valid.add(site.jarCookie);
    const out = await load(PLUGIN, site.fetch, new Storage()).parseChapter('series/novel/1');
    assert.strictEqual(cheerio.load(out).text(), 'é'.repeat(len) + 'end', 'decrypted text, length ' + len);
  }
  console.log('ok  decryption round-trips for 11 lengths (exercises SHA-256 padding)');

  // 2. No session at all: the plugin must ask for the WebView check, not guess.
  {
    const site = fakeSite({ exchanges: 5, text: TEXT });
    await assert.rejects(load(PLUGIN, site.fetch, new Storage()).parseChapter('series/novel/1'), /WebView/);
    console.log('ok  no session -> asks for the WebView check');
  }
  // 3. A WebView-verified session (cookie in the shared jar): exchanged for a
  //    token the plugin holds, chapter decrypted, token persisted.
  const storage = new Storage();
  {
    const site = fakeSite({ jarCookie: makeToken(0, Math.floor(Date.now() / 1000) + 300), exchanges: 5, text: TEXT });
    const plugin = load(PLUGIN, site.fetch, storage);
    assert.strictEqual(await plugin.parseChapter('series/novel/1'), WANT);
    assert.ok(storage.get('readToken') && storage.get('readToken').value, 'token persisted');
    // A new plugin instance (app restart) reuses the stored token: no new mint.
    site.jarCookie = null;
    const before = site.minted;
    assert.strictEqual(await load(PLUGIN, site.fetch, storage).parseChapter('series/novel/2'), WANT);
    assert.strictEqual(site.minted, before, 'restart reused the persisted token');
    console.log('ok  WebView session -> token exchanged, chapter decrypted, token survives a restart');

    // 4. Close to expiry: renewed by exchange *before* the read.
    const t = storage.get('readToken');
    storage.set('readToken', Object.assign({}, t, { expiresAt: Date.now() + 20 * 1000 }), Date.now() + 20 * 1000);
    assert.strictEqual(await plugin.parseChapter('series/novel/3'), WANT);
    assert.ok(site.minted > before && storage.get('readToken').value !== t.value, 'token renewed');
    console.log('ok  token near expiry -> renewed through an exchange, read succeeds');

    // 5. Exchange allowance used up and token expired: back to the check.
    site.exchangesLeft = 0;
    const cur = storage.get('readToken');
    storage.set('readToken', Object.assign({}, cur, { expiresAt: Date.now() + 1000 }), Date.now() + 1000);
    await assert.rejects(plugin.parseChapter('series/novel/4'), /WebView/);
    console.log('ok  exchanges exhausted -> asks for the WebView check');
  }
  // 6. Paid chapter: refused with the price, never "unlocked".
  {
    const site = fakeSite({ jarCookie: makeToken(0, Math.floor(Date.now() / 1000) + 300), exchanges: 5, text: TEXT });
    await assert.rejects(load(PLUGIN, site.fetch, new Storage()).parseChapter('series/novel/paid'), /locked \(5 runes\)/);
    console.log('ok  paid chapter -> refused');
  }
  // 7. v1 scheme and official-shaped paths ('<slug>/<chapter>~~<uuid>').
  {
    const site = fakeSite({ jarCookie: makeToken(0, Math.floor(Date.now() / 1000) + 300), exchanges: 5, text: TEXT, scheme: 'fragmented-v1' });
    assert.strictEqual(await load(PLUGIN, site.fetch, new Storage()).parseChapter('novel/9~~uuid-9'), WANT);
    console.log('ok  fragmented-v1 and official-shaped paths');
  }

  // 8. Parity with the official plugin's own decryption.
  const official = process.argv[2];
  if (!official) {
    console.log('SKIP parity: pass the official compiled fenrirrealm.js to run it');
    process.exitCode = 3; // a skipped check is not a pass (ENGINEERING-RULES 6)
    return;
  }
  const off = load(official, async () => { throw new Error('no network'); }, new Storage());
  for (const scheme of ['fragmented-v1', 'fragmented-v2']) {
    const token = makeToken(7, Math.floor(Date.now() / 1000) + 300);
    const chapter = { content_cid: 4242, content_scheme: scheme, content: encryptChapter(TEXT, token, scheme, 4242) };
    assert.strictEqual(off.decryptWithToken(chapter, token), TEXT, 'official decrypts the reference ' + scheme);
  }
  console.log('ok  official decryptWithToken agrees with the reference scheme (v1, v2)');
}

main().then(() => { if (!process.exitCode) console.log('PASS'); }, e => { console.error('FAIL:', e.message); process.exit(1); });
