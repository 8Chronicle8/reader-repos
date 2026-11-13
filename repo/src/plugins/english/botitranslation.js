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
var defaultCover = require('@libs/defaultCover').defaultCover;

// botitranslation.com is a client-side SPA (no server-rendered HTML to
// scrape) running on the shared "StoryWave" backend. All data comes from
// a public JSON API; the only requirement is a `site-domain` header that
// tells the multi-tenant backend which org's catalog to serve. Paths use
// the book id, so getPath/resolveUrl map cleanly to numeric ids.
var API = 'https://api.mystorywave.com/story-wave-backend/api/v1';
var SITE_DOMAIN = 'www.botitranslation.com';
var PAGE_SIZE = 30;

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'botitranslation';
    this.name = 'Boti Translation-P';
    this.site = 'https://www.botitranslation.com/';
    this.version = '1.1.0';
    this.icon = 'icons/botitranslation.png';
  }

  function api(path, params) {
    var url = API + path;
    if (params) {
      var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      if (q) url += (url.indexOf('?') === -1 ? '?' : '&') + q;
    }
    return fetchApi(url, {
      headers: {
        'site-domain': SITE_DOMAIN,
        'Accept': 'application/json',
        'Referer': 'https://www.botitranslation.com/',
      },
    }).then(function (r) { return r.json(); });
  }

  function mapBook(b) {
    return {
      name: b.title,
      path: String(b.id),
      cover: b.coverImgUrl || defaultCover,
    };
  }

  Plugin.prototype.popularNovels = async function (page, options) {
    var res = await api('/content/books', {
      pageNumber: page, pageSize: PAGE_SIZE,
    });
    if (!res || res.code !== 0 || !res.data || !res.data.list) return [];
    return res.data.list.map(mapBook);
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var id = novelPath.replace(/[^0-9]/g, '');
    var res = await api('/content/books/' + id);
    var b = res && res.data ? res.data : {};

    // Page through the chapter list until every chapter is collected.
    var chapters = [], pageNumber = 1, totalPages = 1;
    do {
      var cr = await api('/content/chapters/page', {
        bookId: id, pageNumber: pageNumber, pageSize: 100,
      });
      if (!cr || cr.code !== 0 || !cr.data || !cr.data.list) break;
      totalPages = cr.data.totalPages || 1;
      cr.data.list.forEach(function (c) {
        var locked = c.paywallStatus && c.paywallStatus !== 'free';
        chapters.push({
          name: (locked ? '\uD83D\uDD12 ' : '') + c.title,
          path: id + '/' + c.id,
          chapterNumber: c.chapterOrder,
          releaseTime: c.publishTime
            ? new Date(c.publishTime).toISOString().slice(0, 10) : undefined,
        });
      });
      pageNumber++;
    } while (pageNumber <= totalPages && pageNumber <= 500);

    // API returns newest-first; sort ascending by chapterOrder.
    chapters.sort(function (a, b2) {
      return (a.chapterNumber || 0) - (b2.chapterNumber || 0);
    });

    return {
      name: b.title || novelPath,
      path: novelPath,
      cover: b.coverImgUrl || defaultCover,
      summary: (b.synopsis || '').replace(/\r/g, ''),
      author: b.authorPseudonym || '',
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var id = chapterPath.split('/').pop().replace(/[^0-9]/g, '');
    var res = await api('/content/chapters/' + id);
    if (!res || !res.data) return '';
    var d = res.data;
    if (!d.content) {
      // Paywalled/unpurchased chapters return no content.
      return '<p><i>This chapter is locked (paid) and cannot be loaded '
        + 'without a subscription.</i></p>';
    }
    return '<h2>' + (d.title || '') + '</h2>' + d.content;
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    // Real server-side search. The param is `keyWord` (capital W) -- the
    // lowercase `keyword` is silently ignored and returns the full list.
    var res = await api('/content/books/search', {
      keyWord: searchTerm, pageNumber: page, pageSize: PAGE_SIZE,
    });
    if (!res || res.code !== 0 || !res.data || !res.data.list) return [];
    return res.data.list.map(mapBook);
  };

  Plugin.prototype.resolveUrl = function (path, isNovel) {
    var parts = String(path).split('/');
    if (isNovel) return this.site + 'story/' + parts[0];
    return this.site + 'viewer/' + parts[parts.length - 1];
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
