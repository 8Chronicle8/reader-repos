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

// Baked-in project list (re-run `lnrepo add` to refresh)
var NOVELS = [
  {
    "name": "108 Maidens of Destiny",
    "path": "108-maidens-of-destiny",
    "cover": "https://i0.wp.com/thesuniscold.translatednovels.com/wp-content/uploads/2017/01/108-bigger-212x300.png?resize=212%2C300"
  },
  {
    "name": "Maiden Galaxy",
    "path": "maiden-galaxy",
    "cover": ""
  },
  {
    "name": "Investiture of the Star Generals",
    "path": "investiture-of-the-star-generals",
    "cover": "https://i0.wp.com/thesuniscold.translatednovels.com/wp-content/uploads/2025/02/92075s.jpg?resize=187%2C272&#038;ssl=1"
  },
  {
    "name": "Back to the Apocalypse",
    "path": "projects/back-to-the-apocalypse",
    "cover": "https://i0.wp.com/thesuniscold.translatednovels.com/wp-content/uploads/2017/02/baijing-264x300.jpg?resize=264%2C300"
  }
];

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'thesuniscold';
    this.name = 'The Sun Is Cold-P';
    this.site = 'https://thesuniscold.translatednovels.com/';
    this.version = '1.1.1';
    this.icon = 'icons/thesuniscold.png';
    // Four novels with no genre or status data on the site: sorting is all
    // there is to offer.
    this.filters = {
      sort: { type: 'Picker', label: 'Sort', value: 'site', options: [{"label": "Site order", "value": "site"}, {"label": "Title A-Z", "value": "asc"}, {"label": "Title Z-A", "value": "desc"}] },
    };
  }
  Plugin.prototype.getPath = function (url) {
    if (!url) return null;
    var host = this.site.replace(/^https?:\/\//, '');
    var u = url.replace(/^https?:\/\//, '');
    if (u.indexOf(host) === 0) {
      return u.substring(host.length).replace(/(^\/+|\/+$)/g, '');
    }
    return null;
  };
  Plugin.prototype.popularNovels = async function (page, options) {
    if (page !== 1) return [];
    var f = (options && options.filters) || {};
    var sort = (f.sort && f.sort.value) || 'site';
    var list = NOVELS.map(function (n) {
      return { name: n.name, path: n.path, cover: n.cover || defaultCover };
    });
    if (sort !== 'site') {
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (sort === 'desc') list.reverse();
    }
    return list;
  };
  Plugin.prototype.parseNovel = async function (novelPath) {
    var slug = novelPath.replace(/\/+$/, '').split('/').pop();
    var data = await fetchApi(this.site + 'wp-json/wp/v2/pages?slug=' + slug)
      .then(function (r) { return r.json(); });
    if (!data || data.length !== 1) throw new Error('not found: ' + novelPath);
    var $ = cheerio.load(data[0].content.rendered);
    var img = $('img').first();
    var self = this, chapters = [], seen = {};
    $('a').each(function () {
      var href = $(this).attr('href');
      var path = href ? self.getPath(href) : null;
      if (!path || seen[path]) return;
      if (path.indexOf(novelPath + '/') === 0 || /^archives\//.test(path)) {
        var name = $(this).text().replace(/\s+/g, ' ').trim();
        if (!name) return;
        seen[path] = 1;
        chapters.push({ name: name, path: path });
      }
    });

    // Numeric ordering: WP chapter-index pages often mix a "Latest
    // Releases" widget (newest first) with the full archive below it,
    // or split chapters across several sub-lists, so raw DOM order
    // frequently isn't reading order. Sort by extracted chapter number
    // when most entries carry one; only treat digits as a chapter
    // number when "chapter" actually appears nearby, so side-stories
    // like "Extra 3: ..." (which contain a stray digit but aren't
    // chapter 3) fall through to the end instead of being misplaced.
    function chNum(name, path) {
      var t = name || '', p = path || '';
      var m = t.match(/(?:chapter|chap|ch)[^0-9]{0,3}(\d+(?:\.\d+)?)/i) ||
        p.match(/chapter[-_]?(\d+(?:\.\d+)?)/i);
      if (m) return parseFloat(m[1]);
      if (/chapter/i.test(t) || /chapter/i.test(p)) {
        var m2 = (t + ' ' + p).match(/(\d+(?:\.\d+)?)/);
        if (m2) return parseFloat(m2[1]);
      }
      return null;
    }
    var nums = chapters.map(function (c) { return chNum(c.name, c.path); });
    var withNum = nums.filter(function (n) { return n !== null; }).length;
    if (chapters.length > 3 && withNum >= chapters.length * 0.6) {
      chapters = chapters.map(function (c, i) { return [nums[i], i, c]; })
        .sort(function (a, b) {
          var x = a[0] === null ? 1e12 : a[0], y = b[0] === null ? 1e12 : b[0];
          return x - y || a[1] - b[1];
        }).map(function (t) { return t[2]; });
    }

    return {
      name: data[0].title.rendered.replace(/<[^>]+>/g, ''),
      path: novelPath,
      cover: img.attr('data-lazy-src') || img.attr('src') || defaultCover,
      summary: $('p').filter(function () {
        return $(this).find('a').length === 0 &&
          $(this).text().trim().length > 40;
      }).first().text().trim(),
      chapters: chapters,
    };
  };
  Plugin.prototype.parseChapter = async function (chapterPath) {
    var m = chapterPath.match(/^archives\/(\d+)$/);
    if (m) {
      var d = await fetchApi(this.site + 'wp-json/wp/v2/posts/' + m[1])
        .then(function (r) { return r.json(); });
      return d && d.content
        ? '<h1>' + d.title.rendered + '</h1>' + d.content.rendered : '';
    }
    var slug = chapterPath.replace(/\/+$/, '').split('/').pop();
    var eps = ['wp-json/wp/v2/pages?slug=', 'wp-json/wp/v2/posts?slug='];
    for (var i = 0; i < eps.length; i++) {
      var res = await fetchApi(this.site + eps[i] + slug)
        .then(function (r) { return r.json(); });
      if (res && res.length === 1) {
        return '<h1>' + res[0].title.rendered + '</h1>' + res[0].content.rendered;
      }
    }
    return '';
  };
  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (page !== 1) return [];
    var q = searchTerm.toLowerCase();
    return NOVELS.filter(function (n) {
      return n.name.toLowerCase().indexOf(q) !== -1;
    }).map(function (n) {
      return { name: n.name, path: n.path, cover: n.cover || defaultCover };
    });
  };
  Plugin.prototype.resolveUrl = function (path) { return this.site + path; };
  return Plugin;
}());
exports.default = new Plugin();
