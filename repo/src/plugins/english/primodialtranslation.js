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
    this.id = 'primodialtranslation';
    this.name = 'Primodial Translation-P';
    this.site = 'https://primodialtranslation.com/';
    this.version = '1.1.0';
    this.icon = 'icons/primodialtranslation.png';
    this.filters = {
      "genre[]": {
        "type": "Checkbox",
        "label": "Genres",
        "value": [],
        "options": [
          {
            "label": "Academy",
            "value": "academy"
          },
          {
            "label": "Action",
            "value": "action"
          },
          {
            "label": "Adult",
            "value": "adult"
          },
          {
            "label": "Adventure",
            "value": "adventure"
          },
          {
            "label": "Apocalypse",
            "value": "apocalypse"
          },
          {
            "label": "Comedy",
            "value": "comedy"
          },
          {
            "label": "Drama",
            "value": "drama"
          },
          {
            "label": "Fantasy",
            "value": "fantasy"
          },
          {
            "label": "Historical",
            "value": "historical"
          },
          {
            "label": "Hunters",
            "value": "hunters"
          },
          {
            "label": "Martial Arts",
            "value": "martial-arts"
          },
          {
            "label": "Mature",
            "value": "mature"
          },
          {
            "label": "Modern Fanstasy",
            "value": "modern-fanstasy"
          },
          {
            "label": "Modern Fantasy",
            "value": "modern-fantasy"
          },
          {
            "label": "Murim",
            "value": "murim"
          },
          {
            "label": "Mystery",
            "value": "mystery"
          },
          {
            "label": "Psychological",
            "value": "psychological"
          },
          {
            "label": "Romance",
            "value": "romance"
          },
          {
            "label": "School Life",
            "value": "school-life"
          },
          {
            "label": "Science Fiction",
            "value": "science-fiction"
          },
          {
            "label": "Seinen",
            "value": "seinen"
          },
          {
            "label": "Shounen",
            "value": "shounen"
          },
          {
            "label": "Showbiz",
            "value": "showbiz"
          },
          {
            "label": "Slice of Life",
            "value": "slice-of-life"
          },
          {
            "label": "Supernatural",
            "value": "supernatural"
          },
          {
            "label": "Tragedy",
            "value": "tragedy"
          },
          {
            "label": "Zombie",
            "value": "zombie"
          }
        ]
      },
      "type[]": {
        "type": "Checkbox",
        "label": "Type",
        "value": [],
        "options": [
          {
            "label": "Dropped",
            "value": "dropped"
          },
          {
            "label": "Web Novel",
            "value": "web-novel"
          }
        ]
      },
      "status": {
        "type": "Picker",
        "label": "Status",
        "value": "",
        "options": [
          {
            "label": "All",
            "value": ""
          },
          {
            "label": "Ongoing",
            "value": "ongoing"
          },
          {
            "label": "Hiatus",
            "value": "hiatus"
          },
          {
            "label": "Completed",
            "value": "completed"
          }
        ]
      },
      "order": {
        "type": "Picker",
        "label": "Order by",
        "value": "popular",
        "options": [
          {
            "label": "Default",
            "value": ""
          },
          {
            "label": "A-Z",
            "value": "title"
          },
          {
            "label": "Z-A",
            "value": "titlereverse"
          },
          {
            "label": "Latest Update",
            "value": "update"
          },
          {
            "label": "Latest Added",
            "value": "latest"
          },
          {
            "label": "Popular",
            "value": "popular"
          },
          {
            "label": "Rating",
            "value": "rating"
          }
        ]
      }
    };
  }
  Plugin.prototype.getPath = function (url) {
    if (!url) return null;
    var host = this.site.replace(/^https?:\/\//, '');
    var u = url.replace(/^https?:\/\//, '');
    if (u.indexOf(host) === 0) {
      return u.substring(host.length).replace(/(^\/+|\/+$)/g, '') + '/';
    }
    return null;
  };
  function parseList($, self) {
    var novels = [];
    $('article.maindet, article.bs, .listupd article').each(function () {
      var a = $(this).find('a').first();
      var img = $(this).find('img').first();
      var path = a.attr('href') ? self.getPath(a.attr('href')) : null;
      if (!path) return;
      var name = a.attr('title') ||
        $(this).find('.tt, .ntitle, h2').first().text();
      novels.push({ name: (name || '').trim(), path: path,
        cover: img.attr('data-src') || img.attr('src') || defaultCover });
    });
    return novels;
  }
  Plugin.prototype.popularNovels = async function (page, options) {
    var f = (options && options.filters) || {};
    var order = options && options.showLatestNovels ? 'latest' : ((f.order && f.order.value) || 'popular');
    var q = 'series/?page=' + page + '&order=' + order;
    Object.keys(f).forEach(function (k) {
      if (k === 'order') return;
      var v = f[k] && f[k].value;
      if (Array.isArray(v)) v.forEach(function (x) { q += '&' + k + '=' + encodeURIComponent(x); });
      else if (v) q += '&' + k + '=' + encodeURIComponent(v);
    });
    var body = await fetchApi(this.site + q).then(function (r) { return r.text(); });
    return parseList(cheerio.load(body), this);
  };
  Plugin.prototype.parseNovel = async function (novelPath) {
    var body = await fetchApi(this.site + novelPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var self = this;
    var img = $('.thumbook img, .sertothumb img, .thumb img').first();
    var chapters = [], seen = {};
    $('.eplister ul li a, .eplister li a').each(function () {
      var href = $(this).attr('href');
      var path = href ? self.getPath(href) : null;
      if (!path || seen[path]) return; // dedupe: themes often embed a
      var name = $(this).find('.epl-title').text() || $(this).text();  // "start reading"/"latest chapter" quick-link inside the same list
      name = name.replace(/\s+/g, ' ').trim();
      if (!name) return;
      seen[path] = 1;
      chapters.push({ name: name, path: path });
    });

    // Numeric ordering safety net: some sites relabel chapters partway
    // through (e.g. "chapter 5" early on, just "412" later), which
    // breaks a simple reverse(). Sort by extracted number when most
    // entries carry one; fall back to DOM-order reversal otherwise.
    function chNum(name, path) {
      var m = (name || '').match(/(\d+(?:\.\d+)?)/) ||
        (path || '').match(/(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : null;
    }
    var nums = chapters.map(function (c) { return chNum(c.name, c.path); });
    var withNum = nums.filter(function (n) { return n !== null; }).length;
    if (chapters.length > 3 && withNum >= chapters.length * 0.9) {
      chapters = chapters.map(function (c, i) { return [nums[i], i, c]; })
        .sort(function (a, b) {
          var x = a[0] === null ? 1e12 : a[0], y = b[0] === null ? 1e12 : b[0];
          return x - y || a[1] - b[1];
        }).map(function (t) { return t[2]; });
    } else {
      chapters.reverse();
    }
    return {
      name: $('h1.entry-title').first().text().trim(),
      path: novelPath,
      cover: img.attr('data-src') || img.attr('src') || defaultCover,
      summary: $('.sersys, .synp .entry-content').first().text().trim(),
      chapters: chapters,
    };
  };
  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(this.site + chapterPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    $('script, noscript, ins, .adsbygoogle').remove();
    return $('.epcontent, .entry-content').first().html() || '';
  };
  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    var body = await fetchApi(this.site + 'page/' + page + '/?s=' +
      encodeURIComponent(searchTerm)).then(function (r) { return r.text(); });
    return parseList(cheerio.load(body), this);
  };
  Plugin.prototype.resolveUrl = function (path) { return this.site + path; };
  return Plugin;
}());
exports.default = new Plugin();
