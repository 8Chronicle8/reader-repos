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
    this.id = 'noicetranslations';
    this.name = 'Noice Translations-P';
    this.site = 'https://noicetranslations.com/';
    this.version = '1.1.0';
    this.icon = 'icons/noicetranslations.png';
    this.filters = {
      "genre[]": {
        "type": "Checkbox",
        "label": "Genre",
        "value": [],
        "options": [
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
            "label": "Chinese",
            "value": "chinese"
          },
          {
            "label": "Comedy",
            "value": "comedy"
          },
          {
            "label": "Cooking",
            "value": "cooking"
          },
          {
            "label": "Detective",
            "value": "detective"
          },
          {
            "label": "Doujinshi",
            "value": "doujinshi"
          },
          {
            "label": "Drama",
            "value": "drama"
          },
          {
            "label": "Ecchi",
            "value": "ecchi"
          },
          {
            "label": "Fantasy",
            "value": "fantasy"
          },
          {
            "label": "fighting",
            "value": "fighting"
          },
          {
            "label": "fun",
            "value": "fun"
          },
          {
            "label": "Gender Bender",
            "value": "gender-bender"
          },
          {
            "label": "girl",
            "value": "girl"
          },
          {
            "label": "Harem",
            "value": "harem"
          },
          {
            "label": "Historical",
            "value": "historical"
          },
          {
            "label": "Horror",
            "value": "horror"
          },
          {
            "label": "horrow",
            "value": "horrow"
          },
          {
            "label": "Josei",
            "value": "josei"
          },
          {
            "label": "Live action",
            "value": "live-action"
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
            "label": "Mecha",
            "value": "mecha"
          },
          {
            "label": "Mystery",
            "value": "mystery"
          },
          {
            "label": "One shot",
            "value": "one-shot"
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
            "label": "Sci-fi",
            "value": "sci-fi"
          },
          {
            "label": "Seinen",
            "value": "seinen"
          },
          {
            "label": "Shoujo",
            "value": "shoujo"
          },
          {
            "label": "Shoujo Ai",
            "value": "shoujo-ai"
          },
          {
            "label": "Shounen",
            "value": "shounen"
          },
          {
            "label": "Shounen Ai",
            "value": "shounen-ai"
          },
          {
            "label": "Slice of Life",
            "value": "slice-of-life"
          },
          {
            "label": "Smut",
            "value": "smut"
          },
          {
            "label": "Soft Yaoi",
            "value": "soft-yaoi"
          },
          {
            "label": "Soft Yuri",
            "value": "soft-yuri"
          },
          {
            "label": "Sports",
            "value": "sports"
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
            "label": "Xianxia",
            "value": "xianxia"
          },
          {
            "label": "Xuanhuan",
            "value": "xuanhuan"
          },
          {
            "label": "Yuri",
            "value": "yuri"
          }
        ]
      },
      "op": {
        "type": "Switch",
        "label": "having all selected genres",
        "value": false
      },
      "author": {
        "type": "Text",
        "label": "Author",
        "value": ""
      },
      "artist": {
        "type": "Text",
        "label": "Artist",
        "value": ""
      },
      "release": {
        "type": "Text",
        "label": "Year of Released",
        "value": ""
      },
      "adult": {
        "type": "Picker",
        "label": "Adult content",
        "value": "",
        "options": [
          {
            "label": "All",
            "value": ""
          },
          {
            "label": "None adult content",
            "value": "0"
          },
          {
            "label": "Only adult content",
            "value": "1"
          }
        ]
      },
      "status[]": {
        "type": "Checkbox",
        "label": "Status",
        "value": [],
        "options": [
          {
            "label": "OnGoing",
            "value": "on-going"
          },
          {
            "label": "Completed",
            "value": "end"
          },
          {
            "label": "Canceled",
            "value": "canceled"
          },
          {
            "label": "On Hold",
            "value": "on-hold"
          },
          {
            "label": "Upcoming",
            "value": "upcoming"
          }
        ]
      },
      "m_orderby": {
        "type": "Picker",
        "label": "Order by",
        "value": "",
        "options": [
          {
            "label": "Relevance",
            "value": ""
          }
        ]
      }
    };
  }
  // Filter values as Madara's search form sends them: one key=value pair per
  // selected value, nothing for a value left at its empty default.
  function filterQuery(filters) {
    var q = '';
    Object.keys(filters || {}).forEach(function (k) {
      var v = filters[k] && filters[k].value;
      if (Array.isArray(v)) v.forEach(function (x) { q += '&' + k + '=' + encodeURIComponent(x); });
      else if (v) q += '&' + k + '=' + encodeURIComponent(v);
    });
    return q;
  }
  function coverOf($, el) {
    var img = $(el).find('img').first();
    return img.attr('data-src') || img.attr('data-lazy-src') ||
      img.attr('src') || defaultCover;
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
  // Madara sites vary in their post-type slug (manga | novel | series | ...).
  // Probe the common ones once and cache whichever actually lists novels.
  var LISTING_BASES = ['novel', 'manga', 'series', 'comics', 'novels', 'webtoon'];
  function collectCards($, self) {
    var novels = [], seen = {};
    // The card selectors overlap on some installs (a featured badge inside a
    // listing card), so the same novel can match twice; keep the first.
    $('.page-item-detail, .c-tabs-item__content, .manga__item, .badge-pos-1').each(function () {
      var a = $(this).find('.post-title a, .h5 a, h3 a, h4 a, a.h5').first();
      if (!a.length) a = $(this).find('a[href*="/"]').first();
      var href = a.attr('href');
      var path = href ? self.getPath(href) : null;
      if (!path || /\/(feed|page)\//.test(path)) return;
      var name = a.text().trim() || a.attr('title') ||
        $(this).find('img').first().attr('alt') || '';
      if (!name || seen[path]) return;
      seen[path] = 1;
      novels.push({ name: name.trim(), path: path, cover: coverOf($, this) });
    });
    return novels;
  }
  Plugin.prototype.popularNovels = async function (page, options) {
    var sort = options && options.showLatestNovels ? 'latest' : 'views';
    var self = this;
    var query = filterQuery(options && options.filters);
    if (query) {
      // Filtered browsing goes through the search form, which every Madara
      // install serves at /page/N/?s=&post_type=wp-manga.
      var found = await fetchApi(this.site + 'page/' + page + '/?s=&post_type=wp-manga' + query +
        (options.showLatestNovels ? '&m_orderby=latest' : '')).then(function (r) { return r.text(); });
      return collectCards(cheerio.load(found), self);
    }
    var bases = this._base ? [this._base] : LISTING_BASES;
    // Page 1 is <base>/?m_orderby= on many Madara sites (/<base>/page/1/
    // 301-redirects); pagination only appends /page/N/ for N > 1.
    var seg = page > 1 ? '/page/' + page + '/' : '/';
    for (var i = 0; i < bases.length; i++) {
      var body = await fetchApi(this.site + bases[i] + seg + '?m_orderby=' + sort)
        .then(function (r) { return r.text(); })
        .catch(function () { return ''; });
      var novels = collectCards(cheerio.load(body), self);
      if (novels.length) { self._base = bases[i]; return novels; }
    }
    return [];
  };
  Plugin.prototype.parseNovel = async function (novelPath) {
    var url = this.site + novelPath;
    var body = await fetchApi(url).then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var self = this;
    var novel = {
      name: $('.post-title h1, .post-title h3').first().text().trim(),
      path: novelPath,
      cover: coverOf($, $('.summary_image')),
      summary: $('.summary__content').text().trim(),
      author: $('.author-content a').first().text().trim(),
      genres: $('.genres-content a').map(function () {
        return $(this).text().trim();
      }).toArray().join(','),
      status: $('.post-status .summary-content').first().text().trim(),
    };
    var chapters = [];
    var collect = function ($$) {
      $$('li.wp-manga-chapter').each(function () {
        var a = $$(this).find('a').first();
        var href = a.attr('href');
        var path = href && href !== '#' ? self.getPath(href) : null;
        if (!path) return;
        // Paid chapters carry premium-block on their <li> (Madara's coin add-on).
        var locked = /\bpremium-block\b/.test($$(this).attr('class') || '');
        chapters.push({ name: (locked ? '\uD83D\uDD12 ' : '') + a.text().trim(), path: path });
      });
    };
    collect($);
    // Modern Madara paginates the chapter list via AJAX. Two known patterns:
    //   1) POST <novelUrl>ajax/chapters/
    //   2) POST wp-admin/admin-ajax.php  action=manga_get_chapters&manga=<id>
    //      where <id> is #manga-chapters-holder[data-id].
    var ajaxHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (!chapters.length) {
      try {
        var ajax = await fetchApi(url.replace(/\/?$/, '/') + 'ajax/chapters/',
          { method: 'POST', headers: ajaxHeaders }).then(function (r) { return r.text(); });
        collect(cheerio.load(ajax));
      } catch (e) {}
    }
    if (!chapters.length) {
      var mid = $('#manga-chapters-holder').attr('data-id') ||
        (body.match(/manga_id["'\s:=]+(\d+)/) || [])[1];
      if (mid) {
        try {
          var ajax2 = await fetchApi(this.site + 'wp-admin/admin-ajax.php', {
            method: 'POST', headers: ajaxHeaders,
            body: 'action=manga_get_chapters&manga=' + mid,
          }).then(function (r) { return r.text(); });
          collect(cheerio.load(ajax2));
        } catch (e) {}
      }
    }
    chapters.reverse();
    novel.chapters = chapters;
    return novel;
  };
  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(this.site + chapterPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    return $('.reading-content, .text-left').first().html() || '';
  };
  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    var body = await fetchApi(this.site + 'page/' + page + '/?s=' +
      encodeURIComponent(searchTerm) + '&post_type=wp-manga')
      .then(function (r) { return r.text(); });
    return collectCards(cheerio.load(body), this);
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
