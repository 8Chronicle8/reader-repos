Object.defineProperty(exports, "__esModule", { value: true });
var _fetchApi = require('@libs/fetch').fetchApi;
// Resilient wrapper: automatic retry with backoff on transient failures
// (network error or 5xx). No abort/timeout on purpose -- aborting a slow but
// working request (heavy pages behind Cloudflare) surfaced as "network request
// failed"; a plain retry is safer. Options are passed through unchanged.
function fetchApi(url, opts) {
  var attempt = 0, MAX = 3;
  function once() {
    attempt++;
    return _fetchApi(url, opts).then(function (r) {
      if (r && !r.ok && r.status >= 500 && attempt < MAX) return again();
      return r;
    }, function (e) {
      if (attempt < MAX) return again();
      throw e;
    });
  }
  function again() {
    return new Promise(function (res) { setTimeout(res, 500 * attempt); }).then(once);
  }
  return once();
}
var cheerio = require('cheerio');
var defaultCover = require('@libs/defaultCover').defaultCover;
var FilterTypes = require('@libs/filterInputs').FilterTypes;
var storage = require('@libs/storage').storage;
var gcm = require('@libs/aes').gcm;

// fenrirealm.com is a SvelteKit front end over a JSON API:
//   browse  : GET api/new/v2/series?sort=popular|latest|updated&page=N&per_page=24
//             (&statuses[]=<status>, &genres[]=<numeric id>; genre slugs are ignored)
//   search  : same endpoint with &search=<term>
//   novel   : GET api/new/v2/series/<slug>,  chapters: .../series/<slug>/chapters
//   chapter : GET api/new/v2/series/<slug>/chapters/<chapterSlug>
//
// Reading a chapter needs a reading session: a cookie the site sets once a
// person passes its check (here: "Open in WebView"). With that session the
// chapter comes back encrypted for a token bound to that one chapter, which
// the site hands out from its mint endpoint and in x-read-token-issued. A
// session can be exchanged for fresh tokens a limited number of times without
// another check. The plugin follows the site's own reader: fetch, mint for
// the chapter when it is locked, decrypt with that chapter's token, and renew
// the session when its last token is about to expire. It never attempts the
// check itself.
var SITE = 'https://fenrirealm.com/';
var API = SITE + 'api/new/v2/';
var PER_PAGE = 24;
var TOKEN_KEY = 'readToken';
var RENEW_MARGIN_MS = 60 * 1000;

var CONTENT_SALT_V1 = 'fr-content-v1', FRAG_SALT_V1 = 'fr-frag-v1';
var CONTENT_SALT_V2 = 'fr-content-v2', FRAG_SALT_V2 = 'fr-frag-v2';
var IV_LEN = 12, TAG_LEN = 16;

// ---------------------------------------------------------------- SHA-256
// The plugin runtime has no WebCrypto, so the digest is computed here. It is
// held to known test vectors in test/fenrir_crypto_test.js.
var K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256Bytes(input) {
  var bytes = new TextEncoder().encode(input);
  var bitLen = bytes.length * 8;
  var padLen = (((bytes.length + 8) >> 6) + 1) << 6;
  var buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  var view = new DataView(buf.buffer);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var w = new Uint32Array(64);
  for (var off = 0; off < padLen; off += 64) {
    for (var i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (i = 16; i < 64; i++) {
      var a = w[i - 15], b = w[i - 2];
      var s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      var s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      var t1 = (H + S1 + ((E & F) ^ (~E & G)) + K[i] + w[i]) >>> 0;
      var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      var t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) >>> 0;
      H = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + A) >>> 0; h[1] = (h[1] + B) >>> 0; h[2] = (h[2] + C) >>> 0; h[3] = (h[3] + D) >>> 0;
    h[4] = (h[4] + E) >>> 0; h[5] = (h[5] + F) >>> 0; h[6] = (h[6] + G) >>> 0; h[7] = (h[7] + H) >>> 0;
  }
  var out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (i = 0; i < 8; i++) ov.setUint32(i * 4, h[i], false);
  return out;
}

// ------------------------------------------------------ content decoding
function b64Bytes(b64) {
  var bin = atob(b64), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function xorshift128Next(state) {
  var t = state[0];
  var r = (t ^ (t << 11)) >>> 0;
  r = (r ^ (r >>> 8)) >>> 0;
  var o = state[3];
  state[0] = state[1]; state[1] = state[2]; state[2] = o;
  var f = (o ^ (o >>> 19) ^ r) >>> 0;
  state[3] = f;
  return f;
}
// Fragmented content arrives in a seeded shuffle; this restores the order.
function unshuffle(fragments, seed) {
  var n = fragments.length;
  if (n < 2) return n === 1 ? fragments[0] : '';
  var d = sha256Bytes(seed), v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  var state = new Uint32Array([v.getUint32(0, true), v.getUint32(4, true), v.getUint32(8, true), v.getUint32(12, true)]);
  var perm = [];
  for (var i = 0; i < n; i++) perm.push(i);
  for (i = n - 1; i > 0; i--) {
    var j = xorshift128Next(state) % (i + 1);
    var tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
  }
  var restored = new Array(n);
  for (i = 0; i < n; i++) restored[perm[i]] = fragments[i];
  return restored.join('');
}
function tokenPayload(token) {
  try {
    var part = String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    part += '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(new TextDecoder().decode(b64Bytes(part))) || {};
  } catch (e) {
    return {};
  }
}
function chapterCid(c) {
  if (typeof c.content_cid === 'number' && c.content_cid > 0) return c.content_cid;
  if (typeof c.id === 'number' && c.id > 0) return c.id;
  return null;
}
// AES-256-GCM with a key derived from the read token; returns null when this
// token is not the one the content was encrypted for (the tag check fails).
function decrypt(c, token) {
  try {
    var v2 = c.content_scheme === 'fragmented-v2';
    var vid = v2 ? (tokenPayload(token).vid || '') : '';
    var cid = chapterCid(c);
    var salt = cid !== null ? cid : (c.uuid || c.id || '');
    var cipher = Array.isArray(c.content)
      ? unshuffle(c.content, v2 ? token + ':' + vid + ':' + salt + ':' + FRAG_SALT_V2
        : token + ':' + salt + ':' + FRAG_SALT_V1)
      : (typeof c.content === 'string' ? c.content : '');
    if (!cipher) return null;
    var raw = b64Bytes(cipher);
    if (raw.length <= IV_LEN + TAG_LEN) return null;
    var seed = v2 && vid !== '' ? token + ':' + vid + ':' + salt + ':' + CONTENT_SALT_V2
      : token + ':' + salt + ':' + CONTENT_SALT_V1;
    var plain = gcm(sha256Bytes(seed), raw.slice(0, IV_LEN)).decrypt(raw.slice(IV_LEN));
    return new TextDecoder().decode(plain);
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ read token
// The reading session itself is a cookie the site sets when a person passes
// its check in the WebView. LNReader shares the WebView's cookies with plugin
// requests, so the plugin never sets a Cookie header: doing so would replace
// the session the WebView created. The token returned by the mint endpoint
// (and rotated in x-read-token-issued) is bound to one chapter and is only
// used to derive that chapter's decryption key and to know when the session
// needs renewing.
function savedToken() {
  var t = storage.get(TOKEN_KEY);
  return t && t.value ? t : null;
}
function saveToken(value, expiresAtSec, remaining, target) {
  if (!value) return null;
  var payload = tokenPayload(value);
  var exp = Number(expiresAtSec) > 0 ? Number(expiresAtSec) : Number(payload.exp);
  var expiresAt = exp > 0 ? exp * 1000 : Date.now() + 5 * 60 * 1000;
  var t = {
    value: value, expiresAt: expiresAt, cid: Number(payload.cid) > 0 ? Number(payload.cid) : null,
    target: target == null ? null : String(target), remaining: remaining == null ? null : Number(remaining),
  };
  // Kept a day past expiry: the chapter it was last renewed for is what the
  // next renewal is sent with.
  storage.set(TOKEN_KEY, t, expiresAt + 24 * 3600 * 1000);
  return t;
}
function captureIssued(res, target) {
  var h = res && res.headers;
  var issued = h && h.get && h.get('x-read-token-issued');
  if (!issued) return null;
  return saveToken(issued, h.get('x-read-token-expires-at'), h.get('x-read-token-exchanges-remaining'), target);
}
// Ask the site for a token for this chapter, exchanging the current session
// (no captcha). Returns {token} or {refused: <why>}.
async function mint(target, diag) {
  var res = await fetchApi(SITE + 'api/read-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(target ? { chapter_id: String(target) } : {}),
  });
  if (res.status === 429) throw rateLimited();
  var data = await res.json().catch(function () { return {}; });
  if (res.ok && data && data.active && data.token) {
    diag.push('mint ok' + (data.exchanges_remaining != null ? ' (' + data.exchanges_remaining + ' left)' : ''));
    return { token: saveToken(data.token, data.expires_at, data.exchanges_remaining, target) };
  }
  var why = data && data.challenge_required ? 'challenge' : (data && data.active === false ? 'inactive' : 'http ' + res.status);
  diag.push('mint ' + why);
  return { refused: why };
}
function rateLimited() {
  return new Error('Fenrir Realm is rate limiting reads (too many requests). Wait a minute, then reload the chapter.');
}
function verifyError(diag) {
  var e = new Error('Fenrir Realm needs its check before this chapter can be read: open the chapter in WebView ' +
    '(globe icon), wait until the chapter text shows, then go back and reload. After that the plugin renews the ' +
    'session by itself until the site asks for a new check. [' + diag.join(', ') + ']');
  e.status = 403;
  return e;
}

// ----------------------------------------------------------------- helpers
function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
function stripTags(s) { return clean(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')); }
function listOf(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}
function coverOf(n) {
  if (n && typeof n.cover === 'string' && n.cover) {
    return /^https?:/i.test(n.cover) ? n.cover : SITE + n.cover.replace(/^\/+/, '');
  }
  return defaultCover;
}
function mapNovel(n) { return { name: clean(n.title) || n.slug, path: 'series/' + n.slug, cover: coverOf(n) }; }
// Library entries store 'series/<slug>' and 'series/<slug>/<chapter>'; paths in
// the official plugin's shape ('<slug>', '<slug>/<chapter>~~<uuid>') are accepted too.
function splitPath(path) {
  var p = String(path).split('~~')[0].replace(/^\/+|\/+$/g, '').replace(/^series\//, '');
  var parts = p.split('/');
  return { slug: parts[0], chapter: parts.slice(1).join('/') };
}
// Locked = has a price and is not yet released for free (scheduled unlocks
// carry a future unlocked_at).
function isLocked(c) {
  var l = (c && c.locked) || {};
  if (!l.price) return false;
  if (c.bought && c.bought.bought_at) return false;
  if (!l.unlocked_at) return true;
  var at = Date.parse(l.unlocked_at);
  return isNaN(at) ? true : at > Date.now();
}
function chapterName(c) {
  var num = c.number != null ? c.number : c.slug;
  var head = clean(c.name) || ('Chapter ' + num);
  var title = clean(c.title);
  if (title && head.toLowerCase().indexOf(title.toLowerCase()) === -1) head += ': ' + title;
  if (c.part) head += ' (Part ' + c.part + ')';
  return (isLocked(c) ? '🔒 ' : '') + head;
}
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
var MARKS = { bold: 'strong', strong: 'strong', italic: 'em', em: 'em', underline: 'u', strike: 's', code: 'code' };
var BLOCKS = { paragraph: 'p', blockquote: 'blockquote', bulletList: 'ul', orderedList: 'ol', listItem: 'li', codeBlock: 'pre' };
// Some chapters are stored as a ProseMirror document rather than HTML.
function renderDoc(node) {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(renderDoc).join('');
  if (typeof node !== 'object') return escapeHtml(node);
  if (node.type === 'text') {
    var out = escapeHtml(node.text || ''), marks = node.marks || [];
    for (var i = marks.length - 1; i >= 0; i--) {
      var m = marks[i] || {}, tag = MARKS[m.type];
      if (m.type === 'link' && m.attrs && m.attrs.href) out = '<a href="' + escapeHtml(m.attrs.href) + '">' + out + '</a>';
      else if (tag) out = '<' + tag + '>' + out + '</' + tag + '>';
    }
    return out;
  }
  if (node.type === 'hardBreak') return '<br>';
  if (node.type === 'horizontalRule') return '<hr>';
  var inner = renderDoc(node.content || []);
  if (node.type === 'heading') {
    var lvl = (node.attrs || {}).level;
    if (!(lvl >= 1 && lvl <= 6)) lvl = 2;
    return '<h' + lvl + '>' + inner + '</h' + lvl + '>';
  }
  var block = BLOCKS[node.type];
  return block ? '<' + block + '>' + inner + '</' + block + '>' : inner;
}
var INVISIBLE = /[​-‏‪-‮⁠﻿]/g;
// Chapter HTML carries hidden duplicate text, reader attributions and
// invisible characters that a browser never displays; keep what it shows.
function formatContent(text) {
  var s = String(text || '').trim();
  if (/^[{[]/.test(s)) {
    try { return renderDoc(JSON.parse(s)).replace(INVISIBLE, '').trim(); } catch (e) { /* not JSON: treat as HTML */ }
  }
  var $ = cheerio.load(s);
  $('[aria-hidden="true"], .reader-attribution, [data-fr-attr], style, script').remove();
  $('p, div, span, small').each(function () {
    var t = $(this).text().trim();
    if (t.indexOf('Copy reference:') === 0 || t.indexOf('Bookmark:') === 0) $(this).remove();
  });
  return ($('body').html() || s).replace(INVISIBLE, '').trim();
}
async function chapterUuid(slug, chapterSlug) {
  var list = listOf(await json('series/' + slug + '/chapters'));
  var hit = list.filter(function (c) { return String(c.slug) === String(chapterSlug); })[0];
  return hit ? (hit.uuid || hit.id || null) : null;
}
async function json(path) {
  var r = await fetchApi(API + path, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Fenrir Realm returned HTTP ' + r.status + ' for ' + path);
  return r.json();
}

var GENRES = ['Action', 'Adult', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Gender Bender', 'Harem',
  'Historical', 'Horror', 'Josei', 'Martial Arts', 'Mature', 'Mecha', 'Mystery', 'Psychological', 'Romance',
  'School Life', 'Sci-fi', 'Seinen', 'Shoujo', 'Shoujo Ai', 'Shounen', 'Shounen Ai', 'Slice of Life', 'Smut',
  'Sports', 'Supernatural', 'Tragedy', 'Wuxia', 'Xianxia', 'Xuanhuan', 'Yaoi', 'Yuri'];

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'fenrirealm';
    this.name = 'Fenrir Realm-P';
    this.site = SITE;
    this.version = '1.1.1';
    this.icon = 'icons/fenrirealm.png';
    // Genre ids are the site's numeric ids (genres[]=<id>); slugs are ignored.
    this.filters = {
      sort: {
        type: FilterTypes.Picker, label: 'Sort', value: 'popular',
        options: [{ label: 'Popular', value: 'popular' }, { label: 'Latest', value: 'latest' },
          { label: 'Updated', value: 'updated' }],
      },
      status: {
        type: FilterTypes.Picker, label: 'Status', value: '',
        options: [{ label: 'All', value: '' }, { label: 'Ongoing', value: 'on-going' },
          { label: 'Completed', value: 'completed' }, { label: 'Hiatus', value: 'hiatus' },
          { label: 'On Hold', value: 'on-hold' }, { label: 'Dropped', value: 'dropped' }],
      },
      genres: {
        type: FilterTypes.CheckboxGroup, label: 'Genres', value: [],
        options: GENRES.map(function (g, i) { return { label: g, value: String(i + 1) }; }),
      },
    };
  }

  Plugin.prototype.popularNovels = async function (page, options) {
    var opts = options || {}, f = opts.filters || {};
    var sort = opts.showLatestNovels ? 'latest' : ((f.sort && f.sort.value) || 'popular');
    var q = 'series?sort=' + sort + '&page=' + page + '&per_page=' + PER_PAGE;
    if (f.status && f.status.value) q += '&statuses[]=' + encodeURIComponent(f.status.value);
    ((f.genres && f.genres.value) || []).forEach(function (g) { q += '&genres[]=' + encodeURIComponent(g); });
    return listOf(await json(q)).filter(function (n) { return n && n.slug; }).map(mapNovel);
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    var q = 'series?search=' + encodeURIComponent(searchTerm) + '&page=' + page + '&per_page=' + PER_PAGE;
    return listOf(await json(q)).filter(function (n) { return n && n.slug; }).map(mapNovel);
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var slug = splitPath(novelPath).slug;
    var res = await json('series/' + slug);
    var s = (res && res.data) || res || {};
    var chapters = listOf(await json('series/' + slug + '/chapters'))
      .filter(function (c) { return c && c.slug != null; })
      .map(function (c) {
        return {
          name: chapterName(c),
          path: 'series/' + slug + '/' + c.slug,
          releaseTime: c.created_at || null,
          chapterNumber: typeof c.number === 'number' ? c.number : undefined,
        };
      });
    chapters.sort(function (a, b) { return (a.chapterNumber || 0) - (b.chapterNumber || 0); });
    return {
      name: clean(s.title) || slug,
      path: 'series/' + slug,
      cover: coverOf(s),
      summary: stripTags(s.description),
      author: (s.user && (s.user.name || s.user.username)) || undefined,
      status: s.status || undefined,
      genres: (s.genres || []).map(function (g) { return g.name || g.slug; }).filter(Boolean).join(',') || undefined,
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var p = splitPath(chapterPath);
    var url = API + 'series/' + p.slug + '/chapters/' + p.chapter;
    var diag = [];
    var load = async function (label) {
      var res = await fetchApi(url, { headers: { 'Accept': 'application/json', 'X-Accepts-Encrypted-Content': '3' } });
      if (res.status === 429) throw rateLimited();
      var data = res.ok ? await res.json() : null;
      var issued = captureIssued(res, data && (data.uuid || data.id));
      diag.push(label + ' ' + res.status + (data ? ' ' + data.content_format : '') + (issued ? ' +token' : ''));
      return { status: res.status, data: data, issued: issued && issued.value };
    };
    var targetOf = function (c) {
      return c && (c.remint_chapter_uuid || c.remint_chapter_id || c.uuid || c.id) || null;
    };

    // Keep the session alive: a stored token in its last minute (or just
    // past it) is renewed through an exchange before the read.
    var saved = savedToken();
    if (saved && saved.expiresAt - Date.now() < RENEW_MARGIN_MS) await mint(saved.target, diag);

    var got = await load('chapter');
    if (got.status === 404) throw new Error('This chapter no longer exists on Fenrir Realm.');
    var minted = null;
    if (!got.data || got.data.content_format === 'locked') {
      var c0 = got.data;
      if (c0 && isLocked(c0)) {
        var price = (c0.locked || {}).price;
        throw new Error('This chapter is locked' + (price ? ' (' + price + ' runes)' : '') +
          '. Unlock it on fenrirealm.com to read it here.');
      }
      var target = targetOf(c0) || await chapterUuid(p.slug, p.chapter);
      var m = await mint(target, diag);
      if (!m.token) throw verifyError(diag);
      minted = m.token.value;
      got = await load('retry');
      if (!got.data || got.data.content_format === 'locked') throw verifyError(diag);
    }

    var c = got.data;
    if (c.content_format === 'encrypted') {
      var tryAll = function (tokens) {
        for (var i = 0; i < tokens.length; i++) {
          var plain = tokens[i] ? decrypt(c, tokens[i]) : null;
          if (plain !== null) return plain;
        }
        return null;
      };
      var cid = chapterCid(c), held = savedToken();
      var plain = tryAll([got.issued, minted, held && (held.cid === null || held.cid === cid) ? held.value : null]);
      if (plain === null) {
        // As the site's reader does: a token for exactly this chapter, then refetch.
        var m2 = await mint(targetOf(c), diag);
        if (!m2.token) throw verifyError(diag);
        got = await load('refetch');
        c = got.data || c;
        plain = c.content_format === 'encrypted' ? tryAll([got.issued, m2.token.value]) : null;
        if (plain === null && c.content_format !== 'encrypted' && typeof c.content === 'string' && c.content) plain = c.content;
      }
      if (plain === null) {
        throw new Error('Fenrir Realm sent this chapter encrypted and the plugin could not read it. Please report ' +
          'this line: [' + diag.join(', ') + ', scheme ' + c.content_scheme + ', cid ' + cid + ']');
      }
      return formatContent(plain);
    }
    if (typeof c.content === 'string' && c.content) return formatContent(c.content);
    throw new Error('Fenrir Realm returned this chapter without any text. [' + diag.join(', ') + ']');
  };

  Plugin.prototype.resolveUrl = function (path, isNovel) {
    var p = splitPath(path);
    return SITE + 'series/' + p.slug + (isNovel || !p.chapter ? '' : '/' + p.chapter);
  };

  return Plugin;
}());
exports.default = new Plugin();

// <private-common>
// Shared by every plugin in this repository that can list a locked chapter.
// Edit tools/private_common.js and run `python3 tools/private_common.py sync`;
// never edit a copy inside a plugin -- `check` fails the tests if one drifts.
//
// A locked (paid) chapter is listed with a leading 🔒, the LNReader convention.
// "Hide locked chapters" drops those from the chapter list. The setting is read
// on every call, so switching it takes effect without restarting the app.
(function (plugin) {
  var storage = require('@libs/storage').storage;
  var LOCKED = /^🔒/;
  plugin.pluginSettings = Object.assign({}, plugin.pluginSettings, {
    hideLocked: { value: '', label: 'Hide locked chapters', type: 'Switch' },
  });
  var parseNovel = plugin.parseNovel;
  plugin.parseNovel = function () {
    return Promise.resolve(parseNovel.apply(plugin, arguments)).then(function (novel) {
      if (storage.get('hideLocked') && novel && Array.isArray(novel.chapters)) {
        novel.chapters = novel.chapters.filter(function (c) { return !LOCKED.test(c.name); });
      }
      return novel;
    });
  };
})(exports.default);
// </private-common>
