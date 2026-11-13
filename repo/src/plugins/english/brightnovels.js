Object.defineProperty(exports, "__esModule", { value: true });
var _fetchApi = require('@libs/fetch').fetchApi;
var cheerio = require('cheerio');
var defaultCover = require('@libs/defaultCover').defaultCover;

// brightnovels.com is a Laravel + Inertia.js (Vue) SPA. Every page ships its
// full props as JSON in the `data-page` attribute of <div id="app">, so there
// is no DOM scraping: parse that JSON like an API response.
//   browse : /series?page=<n>              props.seriesList.data (paginated)
//   novel  : /series/<slug>                props.series
//   chapters: /series/<slug>/chapters      -> raw JSON {chapters:[...]}
//   chapter: /series/<slug>/<chapterSlug>  props.chapter.content
//   search : /api/search?query=<term>      -> {data:{series:[...]}}
// Covers: series/chapter objects carry cover.path -> /storage/<path>.
//
// The site's Cloudflare has at times refused LNReader's native TLS fingerprint
// (only about 1 load in 8 got through) with no challenge to solve. For that
// case the plugin can send its brightnovels.com requests through a proxy you
// run yourself -- tools/cf-worker.js is one, for a free Cloudflare Worker.
// Set its URL under the plugin's settings; empty means connect directly.
// resolveUrl always returns the real site URL.

var SITE = 'https://brightnovels.com/';
var storage = require('@libs/storage').storage;
function proxyBase() {
  var v = storage.get('proxyUrl');
  return v ? String(v).trim().replace(/\/+$/, '') : '';
}
// Wrap a brightnovels.com URL for the proxy when one is set; anything else
// (e.g. an external cover CDN) passes through untouched.
function px(url) {
  var base = proxyBase();
  if (!url || !base) return url;
  return /^https?:\/\/(www\.)?brightnovels\.com\//.test(url)
    ? base + '/proxy?url=' + encodeURIComponent(url) : url;
}
// Resilient wrapper: retry transient failures, and transparently send site
// requests through the proxy above when one is set (callers stay unchanged).
function fetchApi(url, opts) {
  var attempt = 0, MAX = 3;
  function once() {
    attempt++;
    return _fetchApi(px(url), opts).then(function (r) {
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

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'brightnovels';
    this.name = 'Bright Novels-P';
    this.site = SITE;
    this.version = '1.1.1';
    this.icon = 'icons/brightnovels.png';
    // Filters the site's /series page accepts (checked 2026-11-13): sort
    // trending|updated|title (+ order=asc), nothing = newest; status
    // ongoing|completed|hiatus; genres and tags as comma-separated slugs (any
    // of). Genre list from the page's own props. There are 758 tags, so they
    // are typed by name rather than ticked.
    this.filters = {
      sort: { type: 'Picker', label: 'Sort', value: 'trending', options: [{"label": "Trending", "value": "trending"}, {"label": "Newest", "value": ""}, {"label": "Recently updated", "value": "updated"}, {"label": "Title A-Z", "value": "title:asc"}, {"label": "Title Z-A", "value": "title:desc"}] },
      status: { type: 'Picker', label: 'Status', value: '', options: [{"label": "All", "value": ""}, {"label": "Ongoing", "value": "ongoing"}, {"label": "Completed", "value": "completed"}, {"label": "Hiatus", "value": "hiatus"}] },
      genres: { type: 'Checkbox', label: 'Genres (any of)', value: [], options: [{"label": "Action", "value": "action"}, {"label": "Adult", "value": "adult"}, {"label": "Adventure", "value": "adventure"}, {"label": "Comedy", "value": "comedy"}, {"label": "Drama", "value": "drama"}, {"label": "Ecchi", "value": "ecchi"}, {"label": "Fantasy", "value": "fantasy"}, {"label": "Gender Bender", "value": "gender-bender"}, {"label": "Harem", "value": "harem"}, {"label": "Historical", "value": "historical"}, {"label": "Horror", "value": "horror"}, {"label": "Josei", "value": "josei"}, {"label": "Martial Arts", "value": "martial-arts"}, {"label": "Mature", "value": "mature"}, {"label": "Mecha", "value": "mecha"}, {"label": "Mystery", "value": "mystery"}, {"label": "Psychological", "value": "psychological"}, {"label": "Romance", "value": "romance"}, {"label": "School Life", "value": "school-life"}, {"label": "Sci-fi", "value": "sci-fi"}, {"label": "Seinen", "value": "seinen"}, {"label": "Shoujo", "value": "shoujo"}, {"label": "Shoujo Ai", "value": "shoujo-ai"}, {"label": "Shounen", "value": "shounen"}, {"label": "Shounen Ai", "value": "shounen-ai"}, {"label": "Slice of Life", "value": "slice-of-life"}, {"label": "Smut", "value": "smut"}, {"label": "Sports", "value": "sports"}, {"label": "Supernatural", "value": "supernatural"}, {"label": "Tragedy", "value": "tragedy"}, {"label": "Wuxia", "value": "wuxia"}, {"label": "Xianxia", "value": "xianxia"}, {"label": "Xuanhuan", "value": "xuanhuan"}, {"label": "Yaoi", "value": "yaoi"}, {"label": "Yuri", "value": "yuri"}] },
      tags: { type: 'Text', label: 'Tags (names, comma-separated, any of)', value: '' },
    };
    this.pluginSettings = {
      proxyUrl: {
        value: '',
        label: 'Proxy URL (optional): your Cloudflare Worker from tools/cf-worker.js, e.g. https://name.workers.dev. Leave empty to connect directly.',
        type: 'Text',
      },
    };
  }

  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function stripTags(html) { return clean(cheerio.load('<x>' + (html || '') + '</x>').text()); }
  Plugin.prototype.abs = function (u) {
    if (!u) return null;
    if (/^https?:/.test(u)) return u;
    return SITE + String(u).replace(/^\/+/, '');
  };
  function slugOf(path) {
    var m = String(path).match(/series\/([^/]+)/);
    return m ? m[1] : String(path).replace(/^\/+|\/+$/g, '').split('/')[0];
  }
  function coverUrl(o) {
    if (!o) return null;
    var u = null;
    if (o.coverImage) u = o.coverImage.charAt(0) === '/' ? SITE + o.coverImage.replace(/^\/+/, '') : o.coverImage;
    else if (o.cover && o.cover.path) u = SITE + 'storage/' + o.cover.path;
    return px(u);   // route site-hosted cover images through the Worker too
  }
  // Pull Inertia page props out of the #app data-page JSON (cheerio decodes
  // the HTML-entity-escaped attribute for us).
  function inertiaProps(html) {
    var $ = cheerio.load(html);
    var raw = $('#app').attr('data-page') || $('[data-page]').first().attr('data-page');
    if (!raw) return null;
    try { return (JSON.parse(raw) || {}).props || null; } catch (e) { return null; }
  }
  function json(url) {
    return fetchApi(url, { headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); });
  }
  function mapNovel(n) {
    return {
      name: clean(n.title),
      path: 'series/' + n.slug,
      cover: coverUrl(n) || defaultCover,
    };
  }

  // Tag names to the site's slugs: lowercase, '/' and apostrophes dropped,
  // other runs of non-alphanumerics -> '-' (matches all 758 site tags).
  function tagSlugs(text) {
    return String(text || '').split(',').map(function (t) {
      return t.toLowerCase().replace(/['\u2019\/]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }).filter(Boolean);
  }
  Plugin.prototype.popularNovels = async function (page, options) {
    var opts = options || {}, f = opts.filters || {};
    var val = function (k) { return f[k] && f[k].value; };
    var sort = opts.showLatestNovels ? 'updated' : (val('sort') == null ? 'trending' : val('sort'));
    var q = ['page=' + page];
    if (sort) {
      var parts = String(sort).split(':');
      q.push('sort=' + parts[0]);
      if (parts[1]) q.push('order=' + parts[1]);
    }
    if (val('status')) q.push('status=' + encodeURIComponent(val('status')));
    var genres = val('genres') || [];
    if (genres.length) q.push('genres=' + genres.map(encodeURIComponent).join(','));
    var tags = tagSlugs(val('tags'));
    if (tags.length) q.push('tags=' + tags.map(encodeURIComponent).join(','));
    var body = await fetchApi(SITE + 'series?' + q.join('&')).then(function (r) { return r.text(); });
    var props = inertiaProps(body);
    var list = props && props.seriesList && props.seriesList.data;
    if (!Array.isArray(list)) throw new Error('Bright Novels returned no series list (the page layout may have changed)');
    return list.map(mapNovel);
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (page > 1) return [];
    var res = await json(SITE + 'api/search?query=' + encodeURIComponent(searchTerm));
    var list = res && res.data && res.data.series;
    if (!Array.isArray(list)) return [];
    return list.map(mapNovel);
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var slug = slugOf(novelPath);
    novelPath = 'series/' + slug;
    var body = await fetchApi(SITE + novelPath).then(function (r) { return r.text(); });
    var props = inertiaProps(body) || {};
    var s = props.series || {};

    var cj = await json(SITE + novelPath + '/chapters');
    var raw = (cj && cj.chapters) || (Array.isArray(props.allChapters) ? props.allChapters : []);
    var chapters = raw.map(function (c) {
      var locked = c.price > 0 && !c.unlocked_at;
      return {
        name: (locked ? '🔒 ' : '') + (clean(c.name) || clean(c.title) || ('Chapter ' + c.number)),
        path: novelPath + '/' + (c.slug != null ? c.slug : c.number),
        chapterNumber: c.number,
        releaseTime: (c.index_at || c.created_at || '').slice(0, 10) || undefined,
      };
    });
    chapters.sort(function (a, b) { return (a.chapterNumber || 0) - (b.chapterNumber || 0); });

    return {
      name: clean(s.title) || slug,
      path: novelPath,
      cover: coverUrl(s) || defaultCover,
      summary: stripTags(s.description),
      author: (s.user && clean(s.user.name)) || '',
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(SITE + chapterPath).then(function (r) { return r.text(); });
    var props = inertiaProps(body) || {};
    var ch = props.chapter || {};
    if (props.isUnlocked === false || (!ch.content && ch.is_premium)) {
      return '<p><i>This chapter is premium and locked; it cannot be loaded '
        + 'without unlocking it on the site.</i></p>';
    }
    return ch.content || '';
  };

  Plugin.prototype.resolveUrl = function (path) { return SITE + path; };

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
