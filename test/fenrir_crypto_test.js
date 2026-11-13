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

// ---- fake fenrirealm.com, modelled on the site's reader code
// The session is an opaque cookie in the app's jar (set when a person passes
// the check in WebView); the plugin cannot read it and must never send its
// own Cookie header. Tokens are bound to one chapter (cid in the payload).
// mode A: a chapter stays locked until a token is minted for it
// mode B: a chapter comes back encrypted with x-read-token-issued
// mode C: a chapter comes back encrypted without the header
function makeToken(n, cid, expSec) {
  return Buffer.from(JSON.stringify({ vid: 'visitor-1', cid, exp: expSec })).toString('base64url') + '.sig' + n;
}
const CID = { '1': 4241, '2': 4242, '3': 4243, '4': 4244, '9': 4249, paid: 4250 };
function fakeSite(opts) {
  const now = () => Math.floor(Date.now() / 1000);
  const s = { mode: opts.mode || 'A', scheme: opts.scheme || 'fragmented-v2', text: opts.text, minted: 0,
    jar: null, sessions: new Map(), chapterTokens: new Map(), requests: [] };
  s.verifyInWebView = (exchanges, ttl) => {
    const id = 'sess-' + Math.random().toString(36).slice(2);
    s.sessions.set(id, { expires: now() + (ttl || 300), left: exchanges }); s.jar = id; return id;
  };
  let req = null; // the request being served: cookies travel only with credentials 'include'
  const session = () => { const x = req.credentials === 'include' && s.jar && s.sessions.get(s.jar); return x && x.expires > now() ? x : null; };
  const respond = (status, body, headers) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: k => (headers || {})[k.toLowerCase()] || null },
    json: async () => body,
  });
  const tokenFor = (cid) => { s.minted++; const t = makeToken(s.minted, cid, now() + 300); s.chapterTokens.set(cid, t); return t; };
  s.fetch = async (url, o) => {
    o = o || {};
    if (o.headers && Object.keys(o.headers).some(k => k.toLowerCase() === 'cookie')) {
      throw new Error('plugin sent its own Cookie header; that would replace the WebView session');
    }
    req = o;
    s.requests.push((o.method || 'GET') + ' ' + url.replace('https://fenrirealm.com/', ''));
    if (url.endsWith('/api/read-token')) {
      const body = JSON.parse(o.body || '{}'); const sess = session();
      const sameOrigin = o.headers && o.headers.Origin === 'https://fenrirealm.com';
      if (!sess || sess.left <= 0 || !sameOrigin) return respond(403, { error: 'A captcha challenge is required to mint a read token.', challenge_required: true });
      if (!body.chapter_id) return respond(422, { error: 'chapter_id required' });
      const cid = CID[String(body.chapter_id).replace('uuid-', '')];
      sess.left--; sess.expires = now() + 300;   // an exchange renews the session
      const t = tokenFor(cid);
      return respond(200, { active: true, token: t, expires_at: now() + 300, exchanges_remaining: sess.left });
    }
    let m = url.match(/^https:\/\/fenrirealm\.com\/series\/[^/]+\/[^/]+$/);
    if (m) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
      text: async () => '<script>data:{token:void 0,readerPosition:null,hasReadCookie:' + (session() ? 'true' : 'false') + '}</script>' };
    m = url.match(/series\/([^/]+)\/chapters$/);
    if (m) return respond(200, Object.keys(CID).map(k => ({ slug: k, uuid: 'uuid-' + k, number: 1 })));
    m = url.match(/series\/([^/]+)\/chapters\/([^/?]+)$/);
    if (m) {
      const slug = m[2], cid = CID[slug], paid = slug === 'paid';
      const base = { uuid: 'uuid-' + slug, slug, content_cid: cid, locked: paid ? { price: 5, unlocked_at: null } : { price: 0 } };
      const locked = () => respond(200, Object.assign({}, base, { content: '', content_format: 'locked' }));
      if (paid || !session()) return locked();
      let token = s.chapterTokens.get(cid), headers = {};
      if (!token) {
        if (s.mode === 'A') return locked();
        token = tokenFor(cid);
        if (s.mode === 'B') headers['x-read-token-issued'] = token;
      }
      return respond(200, Object.assign({}, base, { content_format: 'encrypted', content_scheme: s.scheme,
        content: encryptChapter(s.text, token, s.scheme, cid) }), headers);
    }
    throw new Error('fake site: unexpected request ' + url);
  };
  return s;
}

const TEXT = '<p>Chapter one — the quiet before the storm.</p><p aria-hidden="true">decoy</p><p>Ünïcode ✓ text.</p>';
const WANT = '<p>Chapter one — the quiet before the storm.</p><p>Ünïcode ✓ text.</p>';

async function main() {
  // 1. Decryption round trips over lengths that straddle SHA-256 block
  //    boundaries, with multibyte text (a wrong digest fails decryption).
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
    const site = fakeSite({ mode: 'B', text: 'é'.repeat(len) + 'end' }); site.verifyInWebView(5);
    const out = await load(PLUGIN, site.fetch, new Storage()).parseChapter('series/novel/1');
    assert.strictEqual(cheerio.load(out).text(), 'é'.repeat(len) + 'end', 'decrypted text, length ' + len);
  }
  console.log('ok  decryption round-trips for 11 lengths (exercises SHA-256 padding)');

  // 2. No session: ask for the WebView check, with a diagnostic line.
  {
    const site = fakeSite({ mode: 'A', text: TEXT });
    await assert.rejects(load(PLUGIN, site.fetch, new Storage()).parseChapter('series/novel/1'),
      /needs its check.*\[chapter request HTTP 200 locked; token request HTTP 403 challenge; session cookie not seen\]/);
    console.log('ok  no session -> asks for the WebView check, and says the cookie did not arrive');
    // A session cookie that arrives but is refused is told apart from a missing one.
    const refused = fakeSite({ mode: 'A', text: TEXT }); refused.verifyInWebView(0);
    await assert.rejects(load(PLUGIN, refused.fetch, new Storage()).parseChapter('series/novel/1'),
      /refused this app's connection even though your WebView check passed.*Read this chapter in WebView.*session cookie seen\]/);
    console.log('ok  session present but refused -> says to read in WebView, diagnostic "session cookie seen"');
  }
  // 3-5. After the WebView check, every way the site may hand out the token.
  for (const mode of ['A', 'B', 'C']) {
    const site = fakeSite({ mode, text: TEXT }); site.verifyInWebView(5);
    assert.strictEqual(await load(PLUGIN, site.fetch, new Storage()).parseChapter('series/novel/1'), WANT, 'mode ' + mode);
    const mints = site.requests.filter(r => r.startsWith('POST')).length;
    assert.ok(mode === 'B' ? mints === 0 : mints === 1, `mode ${mode}: ${mints} mint(s)`);
  }
  console.log('ok  WebView session -> chapter read when locked-until-mint, issued in a header, or encrypted without one');

  // 6. Renewal: a stored token in its last minute is exchanged first, which
  //    renews the session; then a session past its life is still readable
  //    only because it was renewed.
  {
    const storage = new Storage();
    const site = fakeSite({ mode: 'A', text: TEXT }); const sid = site.verifyInWebView(5, 120);
    const plugin = load(PLUGIN, site.fetch, storage);
    assert.strictEqual(await plugin.parseChapter('series/novel/1'), WANT);
    const t = storage.get('readToken'); assert.ok(t && t.target === 'uuid-1', 'token stored with its chapter');
    storage.set('readToken', Object.assign({}, t, { expiresAt: Date.now() + 20 * 1000 }));
    site.sessions.get(sid).expires = Math.floor(Date.now() / 1000) + 20;
    const before = site.requests.length;
    assert.strictEqual(await load(PLUGIN, site.fetch, storage).parseChapter('series/novel/2'), WANT);
    assert.ok(site.requests[before].startsWith('POST'), 'renewed before reading');
    assert.ok(site.sessions.get(sid).expires > Math.floor(Date.now() / 1000) + 200, 'session extended');
    console.log('ok  token near expiry -> session renewed by an exchange before the read, across a restart');

    // 7. Allowance used up and session over: back to the check.
    site.sessions.get(sid).left = 0; site.sessions.get(sid).expires = 0;
    await assert.rejects(plugin.parseChapter('series/novel/3'), /WebView/);
    console.log('ok  exchanges exhausted -> asks for the WebView check');
  }
  // 8. Paid chapter: refused with the price, never "unlocked".
  {
    const site = fakeSite({ mode: 'B', text: TEXT }); site.verifyInWebView(5);
    await assert.rejects(load(PLUGIN, site.fetch, new Storage()).parseChapter('series/novel/paid'), /locked \(5 runes\)/);
    console.log('ok  paid chapter -> refused');
  }
  // 9. v1 scheme and official-shaped paths ('<slug>/<chapter>~~<uuid>').
  {
    const site = fakeSite({ mode: 'A', text: TEXT, scheme: 'fragmented-v1' }); site.verifyInWebView(5);
    assert.strictEqual(await load(PLUGIN, site.fetch, new Storage()).parseChapter('novel/9~~uuid-9'), WANT);
    console.log('ok  fragmented-v1 and official-shaped paths');
  }

// 10. Parity with the official plugin's own decryption.
  const official = process.argv[2];
  if (!official) {
    console.log('SKIP parity: pass the official compiled fenrirrealm.js to run it');
    process.exitCode = 3; // a skipped check is not a pass (ENGINEERING-RULES 6)
    return;
  }
  const off = load(official, async () => { throw new Error('no network'); }, new Storage());
  for (const scheme of ['fragmented-v1', 'fragmented-v2']) {
    const token = makeToken(7, 4242, Math.floor(Date.now() / 1000) + 300);
    const chapter = { content_cid: 4242, content_scheme: scheme, content: encryptChapter(TEXT, token, scheme, 4242) };
    assert.strictEqual(off.decryptWithToken(chapter, token), TEXT, 'official decrypts the reference ' + scheme);
  }
  console.log('ok  official decryptWithToken agrees with the reference scheme (v1, v2)');
}

main().then(() => { if (!process.exitCode) console.log('PASS'); }, e => { console.error('FAIL:', e.message); process.exit(1); });
