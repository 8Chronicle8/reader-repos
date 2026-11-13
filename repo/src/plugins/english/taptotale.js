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

// TapToTale is a WordPress site where each *category* is a novel and each
// *post* in that category is a chapter. The generic wpblog engine expects
// pages-as-novels, so this uses the WP REST API against categories/posts.
var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'taptotale';
    this.name = 'TapToTale-P';
    this.site = 'https://taptotale.com/';
    this.version = '1.1.1';
    this.icon = 'icons/taptotale.png';
    // Each novel is a WordPress category; the REST API sorts categories by
    // chapter count, name or id. The site has no genres or tags to filter on.
    this.filters = {
      sort: { type: 'Picker', label: 'Sort', value: 'count:desc', options: [{"label": "Most chapters", "value": "count:desc"}, {"label": "Title A-Z", "value": "name:asc"}, {"label": "Title Z-A", "value": "name:desc"}, {"label": "Newest added", "value": "id:desc"}] },
    };
  }

  function coverFromDesc(html) {
    var $ = cheerio.load(html || '');
    var img = $('img').first();
    return img.attr('src') || null;
  }
  function textFromDesc(html) {
    var $ = cheerio.load(html || '');
    $('img').remove();
    return $.text().replace(/\s+/g, ' ').trim();
  }

  Plugin.prototype.popularNovels = async function (page, options) {
    var f = (options && options.filters) || {};
    var sort = (options && options.showLatestNovels) ? 'id:desc' : ((f.sort && f.sort.value) || 'count:desc');
    var parts = sort.split(':');
    var res = await fetchApi(this.site + 'wp-json/wp/v2/categories?per_page=100&orderby=' + parts[0] +
      '&order=' + parts[1] + '&page=' + page)
      .then(function (r) { return r.json(); });
    if (!Array.isArray(res)) return [];
    return res.filter(function (c) { return c.count > 0; }).map(function (c) {
      return {
        name: c.name,
        path: 'cat/' + c.id + '/' + c.slug,
        cover: coverFromDesc(c.description) || defaultCover,
      };
    });
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var parts = novelPath.split('/');
    var catId = parts[1];
    var cat = await fetchApi(this.site + 'wp-json/wp/v2/categories/' + catId)
      .then(function (r) { return r.json(); });

    var chapters = [], page = 1, totalPages = 1;
    do {
      var resp = await fetchApi(this.site +
        'wp-json/wp/v2/posts?categories=' + catId +
        '&per_page=100&order=asc&orderby=date&page=' + page +
        '&_fields=id,title,slug,link');
      totalPages = parseInt(resp.headers.get('x-wp-totalpages') || '1', 10);
      var list = await resp.json();
      if (!Array.isArray(list)) break;
      list.forEach(function (p) {
        chapters.push({
          name: cheerio.load(p.title.rendered).root().text().trim(),
          path: 'post/' + p.id,
        });
      });
      page++;
    } while (page <= totalPages && page <= 100);

    return {
      name: cat.name,
      path: novelPath,
      cover: coverFromDesc(cat.description) || defaultCover,
      summary: textFromDesc(cat.description),
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var id = chapterPath.split('/').pop();
    var post = await fetchApi(this.site + 'wp-json/wp/v2/posts/' + id +
      '?_fields=title,content').then(function (r) { return r.json(); });
    if (!post || !post.content) return '';
    return '<h2>' + post.title.rendered + '</h2>' + post.content.rendered;
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    var res = await fetchApi(this.site +
      'wp-json/wp/v2/categories?per_page=100&search=' +
      encodeURIComponent(searchTerm)).then(function (r) { return r.json(); });
    if (!Array.isArray(res)) return [];
    return res.filter(function (c) { return c.count > 0; }).map(function (c) {
      return {
        name: c.name,
        path: 'cat/' + c.id + '/' + c.slug,
        cover: coverFromDesc(c.description) || defaultCover,
      };
    });
  };

  Plugin.prototype.resolveUrl = function (path) {
    var parts = path.split('/');
    if (parts[0] === 'cat') return this.site + 'category/' + parts[2] + '/';
    return this.site + '?p=' + parts[1];
  };

  return Plugin;
}());
exports.default = new Plugin();
