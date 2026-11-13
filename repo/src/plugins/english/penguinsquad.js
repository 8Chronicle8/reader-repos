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

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'penguinsquad';
    this.name = 'Penguin Squad-P';
    this.site = 'https://penguin-squad.com/';
    this.version = '1.1.0';
    this.icon = 'icons/penguinsquad.png';
  }

  Plugin.prototype.abs = function (href) {
    if (!href) return null;
    if (/^https?:/.test(href)) return href;
    if (href.indexOf('//') === 0) return 'https:' + href;
    return this.site + href.replace(/^\/+/, '');
  };

  Plugin.prototype.getPath = function (url) {
    url = this.abs(url);
    if (!url) return null;
    var host = this.site.replace(/^https?:\/\//, '');
    var u = url.replace(/^https?:\/\//, '');
    if (u.indexOf(host) === 0) {
      return u.substring(host.length).replace(/(^\/+|\/+$)/g, '');
    }
    return null;
  };

  // The site streams its data as escaped JSON inside
  // `self.__next_f.push([1,"...", ...])` script tags (Next.js RSC
  // payload). The chapter list on the page itself is capped and only
  // expands via client JS ("Show N more"), so we pull the complete,
  // already-ordered array straight out of that payload instead of the
  // visibly-rendered DOM.
  //
  // The payload is JS-string-escaped JSON. Rather than hand-parsing
  // escape sequences (fragile: titles can contain quotes, unicode
  // punctuation, etc.), we locate the enclosing `push([1,"..."])`
  // string literal and let JSON.parse do the real unescaping, then do
  // plain bracket-matching on the now-clean text.
  function extractJsonArray(rawHtml, key) {
    var marker = '\\"' + key + '\\":[';
    var markerPos = rawHtml.indexOf(marker);
    if (markerPos === -1) return null;

    var pushMarker = 'push([1,"';
    var pushPos = rawHtml.lastIndexOf(pushMarker, markerPos);
    if (pushPos === -1) return null;
    var strStart = pushPos + pushMarker.length;

    var i = strStart, esc = false;
    for (; i < rawHtml.length; i++) {
      var c = rawHtml[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') break;
    }
    var jsStringBody = rawHtml.substring(strStart, i);

    var realText;
    try { realText = JSON.parse('"' + jsStringBody + '"'); }
    catch (e) { return null; }

    var start2 = realText.indexOf('"' + key + '":[');
    if (start2 === -1) return null;
    var j = start2 + key.length + 3;
    var depth = 0, inStr = false, esc2 = false;
    for (; j < realText.length; j++) {
      var c2 = realText[j];
      if (esc2) { esc2 = false; continue; }
      if (c2 === '\\') { esc2 = true; continue; }
      if (c2 === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c2 === '[') depth++;
      else if (c2 === ']') { depth--; if (depth === 0) { j++; break; } }
    }
    var finalSlice = realText.substring(start2 + key.length + 3, j);
    try { return JSON.parse(finalSlice); } catch (e) { return null; }
  }

  Plugin.prototype.popularNovels = async function (page) {
    if (page !== 1) return [];
    var body = await fetchApi(this.site + 'novels')
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var self = this, novels = [], seen = {};
    $('a[href^="/novels/"]').each(function () {
      var a = $(this);
      var path = self.getPath(a.attr('href'));
      if (!path || seen[path]) return;
      var name = a.find('h3').first().text().trim();
      if (!name) return;
      var img = a.find('img').first();
      seen[path] = 1;
      novels.push({
        name: name,
        path: path,
        cover: img.attr('src') || defaultCover,
      });
    });
    return novels;
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var body = await fetchApi(this.site + novelPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);

    var name = $('h1').first().text().trim();
    var summary = $('p.text-muted-foreground.mt-3').first().text().trim();
    var cover = $('img[src*="covers/"]').first().attr('src') || defaultCover;

    var raw = extractJsonArray(body, 'chapters');
    var chapters = [];
    if (raw) {
      chapters = raw
        .slice()
        .sort(function (a, b) { return (a.chapter_number || 0) - (b.chapter_number || 0); })
        .map(function (c) {
          return {
            name: (c.premium ? '\uD83D\uDD12 ' : '') + c.title,
            path: novelPath + '/' + c.slug,
          };
        });
    }

    return { name: name, path: novelPath, cover: cover, summary: summary, chapters: chapters };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(this.site + chapterPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var el = $('.reader-content').first();
    if (!el.length) return '';
    el.find('script,style,button').remove();
    return el.html() || '';
  };

  // No server-side search endpoint was found (results appear to load
  // client-side only), so fall back to filtering the full catalog.
  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (page !== 1) return [];
    var all = await this.popularNovels(1);
    var q = searchTerm.toLowerCase();
    return all.filter(function (n) {
      return n.name.toLowerCase().indexOf(q) !== -1;
    });
  };

  Plugin.prototype.resolveUrl = function (path) { return this.site + path; };

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
