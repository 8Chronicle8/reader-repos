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

// Novellunar sits behind Cloudflare. LNReader passes the WebView's clearance
// cookie on to plugin requests, so once the check is done in WebView the
// pages load; until then the reply is the challenge page, which must not be
// read as "no novels".
function pageText(url) {
  return fetchApi(url).then(function (r) {
    return r.text().then(function (t) {
      if ((r.status === 403 || r.status === 503) && /cloudflare|cf-chl|Just a moment|Attention Required/i.test(t)) {
        throw new Error('Novellunar is showing a Cloudflare check. Open the site in WebView (globe icon), ' +
          'complete the check, then go back and retry.');
      }
      if (!r.ok) throw new Error('Novellunar returned HTTP ' + r.status + ' for ' + url);
      return t;
    });
  });
}
var defaultCover = require('@libs/defaultCover').defaultCover;

// novellunar.com is a Next.js App Router (RSC) site. Novel/chapter data is
// streamed as escaped JSON inside self.__next_f.push([1,"..."]) chunks, not
// rendered into scrapeable HTML. Two facts drive this plugin:
//
//   * The full chapter LIST is embedded on a *chapter* page (key "chapters"),
//     NOT on the novel page (which paginates chapters client-side). So to
//     enumerate chapters we read chapter 1's payload.
//   * The chapter BODY is a plain-text React Flight "T" chunk referenced by
//     {"content":"$<id>"}. Its "<id>:T<hex>," header length is a UTF-8 BYTE
//     count, and the text itself contains newlines + multibyte punctuation,
//     so it must be sliced by byte length, then split into paragraphs.
//
// Covers follow a fixed pattern: https://img.novellunar.com/<slug>.webp

var SITE = 'https://novellunar.com/';
var IMG = 'https://img.novellunar.com/';

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'novellunar';
    this.name = 'Novellunar-P';
    this.site = SITE;
    this.version = '1.1.1';
    this.icon = 'icons/novellunar.png';
    // The site's two listing pages; nothing else could be read while it sits
    // behind Cloudflare (2026-11), so there is no genre or status filter.
    this.filters = {
      sort: { type: 'Picker', label: 'Sort', value: 'ranking', options: [{"label": "Ranking", "value": "ranking"}, {"label": "Latest", "value": "latest"}] },
    };
  }

  Plugin.prototype.abs = function (href) {
    if (!href) return null;
    if (/^https?:/.test(href)) return href;
    if (href.indexOf('//') === 0) return 'https:' + href;
    return SITE + href.replace(/^\/+/, '');
  };
  Plugin.prototype.getPath = function (url) {
    url = this.abs(url);
    if (!url) return null;
    var host = SITE.replace(/^https?:\/\//, '');
    var u = url.replace(/^https?:\/\//, '').replace(/#.*$/, '');
    if (u.indexOf(host) === 0) {
      return u.substring(host.length).replace(/(^\/+|\/+$)/g, '');
    }
    return null;
  };
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function slugOf(novelPath) {
    // novelPath is "novel/<slug>"
    var m = String(novelPath).match(/novel\/([^/]+)/);
    return m ? m[1] : String(novelPath).replace(/^\/+|\/+$/g, '');
  }

  // Reconstruct the RSC data stream: concatenate every push([1,"..."]) string
  // literal, JSON-unescaping each so we operate on the real (unescaped) text.
  function rscStream(html) {
    var re = /__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g, m, out = '';
    while ((m = re.exec(html)) !== null) {
      try { out += JSON.parse('"' + m[1] + '"'); }
      catch (e) { out += m[1]; }
    }
    return out;
  }

  // Bracket-match a JSON array that follows a "<key>":[ marker in the stream.
  function extractJsonArray(stream, key) {
    var marker = '"' + key + '":[';
    var s = stream.indexOf(marker);
    if (s === -1) return null;
    var j = s + marker.length - 1, depth = 0, inStr = false, esc = false;
    for (; j < stream.length; j++) {
      var c = stream[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { j++; break; } }
    }
    try { return JSON.parse(stream.substring(s + marker.length - 1, j)); }
    catch (e) { return null; }
  }

  // Extract a React Flight text chunk "<id>:T<hexByteLen>,<utf8 text>".
  // Slice by UTF-8 byte length WITHOUT TextEncoder (may be absent in the
  // plugin sandbox): walk UTF-16 code units, summing each char's byte width.
  function extractTextChunk(stream, id) {
    // Chunk headers follow a structural terminator of the previous row
    // (newline, or the closing } ] " of the previous chunk's payload).
    var re = new RegExp('(?:^|[\\n}\\]"])' + id + ':T([0-9a-fA-F]+),');
    var m = re.exec(stream);
    if (!m) return null;
    var need = parseInt(m[1], 16);
    var start = m.index + m[0].length;
    var bytes = 0, i = start;
    for (; i < stream.length && bytes < need; i++) {
      var c = stream.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { bytes += 4; i++; } // surrogate pair
      else bytes += 3;
    }
    return stream.substring(start, i);
  }

  // Resolve the chapter body text out of a chapter page's RSC stream.
  function chapterText(stream) {
    var ref = stream.match(/"content":"\$(\w+)"/);
    if (ref) {
      var t = extractTextChunk(stream, ref[1]);
      if (t) return t;
    }
    // Fallback: content stored inline as a JSON string.
    var m = stream.match(/"content":"((?:[^"\\]|\\.){200,}?)","contentLength"/);
    if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch (e) {} }
    return '';
  }

  // Collect novel cards from a listing page's rendered HTML.
  Plugin.prototype.cardsFrom = function (html) {
    var $ = cheerio.load(html), self = this, out = [], seen = {};
    $('a[href^="/novel/"]').each(function () {
      var a = $(this);
      var path = self.getPath(a.attr('href'));
      // novel landing pages are exactly "novel/<slug>" (skip chapter links)
      if (!path || seen[path] || path.split('/').length !== 2) return;
      var img = a.find('img').first();
      var name = clean(img.attr('alt') || a.attr('title') || a.text());
      if (!name) return;
      name = name.replace(/\s+Novel$/i, '');
      seen[path] = 1;
      out.push({
        name: name,
        path: path,
        cover: self.abs(img.attr('src') || img.attr('data-src')) ||
          IMG + slugOf(path) + '.webp' || defaultCover,
      });
    });
    return out;
  };

  Plugin.prototype.popularNovels = async function (page, options) {
    // Each listing is a single page.
    if (page !== 1) return [];
    var f = (options && options.filters) || {};
    var path = (options && options.showLatestNovels) ? 'latest' : ((f.sort && f.sort.value) || 'ranking');
    var html = await pageText(SITE + path);
    return this.cardsFrom(html);
  };

  // The site has no server-side search API (every page returns the same fixed
  // set), so search widens coverage by unioning the catalog embedded in the RSC
  // (`novelLinks`) with the cards rendered on the browse pages, then filters by
  // the term locally. All pages are fetched in parallel to keep it fast.
  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (page > 1) return [];
    var self = this, q = clean(searchTerm).toLowerCase();
    var urls = [SITE + 'search?q=' + encodeURIComponent(searchTerm), SITE, SITE + 'ranking', SITE + 'latest'];
    var htmls = await Promise.all(urls.map(function (u) {
      return pageText(u);
    }));
    var all = [], seen = {};
    function add(n) { if (n && n.path && !seen[n.path]) { seen[n.path] = 1; all.push(n); } }
    htmls.forEach(function (html, idx) {
      if (!html) return;
      if (idx === 0) {  // /search embeds the catalog in the RSC under novelLinks
        (extractJsonArray(rscStream(html), 'novelLinks') || []).forEach(function (n) {
          if (n && n.slug && n.title) add({
            name: clean(n.title), path: 'novel/' + n.slug,
            cover: n.coverImage || (IMG + n.slug + '.webp'),
          });
        });
      }
      self.cardsFrom(html).forEach(add);
    });
    return all.filter(function (n) { return n.name.toLowerCase().indexOf(q) !== -1; });
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var slug = slugOf(novelPath);
    // Novel page: rich metadata (title / cover / synopsis) via OG + meta tags.
    var body = await pageText(SITE + novelPath);
    var $ = cheerio.load(body);
    var name = clean($('meta[property="og:title"]').attr('content') ||
      $('h1').first().text()).replace(/\s+Novel$/i, '');
    var cover = $('meta[property="og:image"]').attr('content') ||
      IMG + slug + '.webp';
    var summary = clean($('meta[name="description"]').attr('content') || '')
      .replace(/^Read\s+'.*?'\s+Novel Online for Free[,.]?\s*/i, '');

    // Chapter list lives in a CHAPTER page's payload, not the novel page.
    var chHtml = await pageText(SITE + 'novel/' + slug + '/chapter/1');
    var stream = rscStream(chHtml);
    var raw = extractJsonArray(stream, 'chapters') || [];
    var chapters = raw.map(function (c) {
      var n = c.chapterNumber != null ? c.chapterNumber : c.number;
      return {
        name: clean(c.title) || ('Chapter ' + n),
        path: 'novel/' + slug + '/chapter/' + n,
        chapterNumber: n,
        releaseTime: c.createdAt ? c.createdAt.slice(0, 10) : undefined,
      };
    }).filter(function (c) { return c.chapterNumber != null; });
    // ensure ascending, dedup by number
    var byNum = {};
    chapters.forEach(function (c) { byNum[c.chapterNumber] = c; });
    chapters = Object.keys(byNum)
      .map(function (k) { return byNum[k]; })
      .sort(function (a, b) { return a.chapterNumber - b.chapterNumber; });

    return {
      name: name || slug,
      path: novelPath,
      cover: cover || defaultCover,
      summary: summary,
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await pageText(SITE + chapterPath);
    var stream = rscStream(body);
    var text = chapterText(stream);
    if (!text) return '';
    var paras = text.split(/\n{2,}/);
    if (paras.length < 2) paras = text.split(/\n/);
    return paras
      .map(function (p) { return clean(p); })
      .filter(function (p) { return p.length; })
      .map(function (p) { return '<p>' + p + '</p>'; })
      .join('\n');
  };

  Plugin.prototype.resolveUrl = function (path) { return SITE + path; };

  return Plugin;
}());
exports.default = new Plugin();
