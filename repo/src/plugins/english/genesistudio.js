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

// genesistudio.com is a Next.js App Router site backed by a Directus CMS
// (proxied at /api/directus/...) plus Supabase storage. What each surface uses:
//   browse : GET /api/directus/novels?fields=[...]&sort=-date_created   (bare JSON array)
//   search : GET /api/directus/novels?filter[novel_title][_icontains]=<term>
//   novel  : /novels/<slug>  -> RSC embeds "initialChapters":[{id,chapter_number,
//            chapter_title,isPaid,isUnlocked,tier,...}] (complete list) + synopsis
//   chapter: GET /api/chapters/<id>/content -> {success, data:{chapter_content}}
//            (the chapter page's own RSC ships content:"" — the body is API-only)
//   cover  : https://api.genesistudio.com/storage/v1/object/public/directus/<filename_disk>
// Chapter paths carry the numeric chapter id after "::" so parseChapter can hit
// the content API while resolveUrl still rebuilds the human /chapter-N URL.

var SITE = 'https://genesistudio.com/';
var STORAGE = 'https://api.genesistudio.com/storage/v1/object/public/directus/';
var NOVEL_FIELDS = '["novel_title","slug","cover.filename_disk"]';

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'genesistudio';
    this.name = 'Genesis Studio-P';
    this.site = SITE;
    this.version = '1.1.0';
    this.icon = 'icons/genesistudio.png';
    // Genre ids as the official LNReader genesis plugin lists them
    // (lnreader-plugins plugins/v3.0.0@1e116f1); sorts use the Directus fields
    // the site serves (date_created, last_updated, rating, rating_count).
    this.filters = {
      "sort": {
        "type": "Picker",
        "label": "Sort",
        "value": "-date_created",
        "options": [
          {
            "label": "Newest",
            "value": "-date_created"
          },
          {
            "label": "Recently updated",
            "value": "-last_updated"
          },
          {
            "label": "Top rated",
            "value": "-rating"
          },
          {
            "label": "Most rated",
            "value": "-rating_count"
          }
        ]
      },
      "genres": {
        "type": "Checkbox",
        "label": "Genres (any of)",
        "value": [],
        "options": [
          {
            "label": "Academy",
            "value": "21"
          },
          {
            "label": "Action",
            "value": "1"
          },
          {
            "label": "Adventure",
            "value": "15"
          },
          {
            "label": "Calm Protagonist",
            "value": "22"
          },
          {
            "label": "Comedy",
            "value": "2"
          },
          {
            "label": "Cultivation",
            "value": "25"
          },
          {
            "label": "Drama",
            "value": "3"
          },
          {
            "label": "Fantasy",
            "value": "5"
          },
          {
            "label": "Harem",
            "value": "11"
          },
          {
            "label": "Idol",
            "value": "20"
          },
          {
            "label": "Martial Arts",
            "value": "6"
          },
          {
            "label": "Modern",
            "value": "4"
          },
          {
            "label": "Modern Fantasy",
            "value": "27"
          },
          {
            "label": "Mystery",
            "value": "8"
          },
          {
            "label": "Psychological",
            "value": "10"
          },
          {
            "label": "Romance",
            "value": "9"
          },
          {
            "label": "School Life",
            "value": "13"
          },
          {
            "label": "Sci-fi",
            "value": "24"
          },
          {
            "label": "Slice of Life",
            "value": "7"
          },
          {
            "label": "Supernatural",
            "value": "14"
          },
          {
            "label": "Tragedy",
            "value": "12"
          },
          {
            "label": "Transmigration",
            "value": "23"
          },
          {
            "label": "Yandere",
            "value": "26"
          }
        ]
      }
    };
  }

  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function directus(query) {
    return fetchApi(SITE + 'api/directus/' + query, {
      headers: { 'Accept': 'application/json' },
    }).then(function (r) { return r.json(); });
  }
  function asList(res) {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.data)) return res.data;
    return [];
  }
  function coverOf(n) {
    var c = n.cover;
    if (c && c.filename_disk) return STORAGE + c.filename_disk;
    if (typeof c === 'string' && c) return STORAGE + c + '.webp';
    return defaultCover;
  }
  function mapNovel(n) {
    return { name: clean(n.novel_title), path: 'novels/' + n.slug, cover: coverOf(n) };
  }
  function slugOf(path) {
    var m = String(path).match(/novels\/([^/]+)/);
    return m ? m[1] : String(path).replace(/^\/+|\/+$/g, '').split('/')[0];
  }

  // Reconstruct the Next.js RSC data stream from the page HTML.
  function rscStream(html) {
    var re = /__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g, m, out = '';
    while ((m = re.exec(html)) !== null) {
      try { out += JSON.parse('"' + m[1] + '"'); } catch (e) { out += m[1]; }
    }
    return out;
  }
  // Resolve a React Flight text chunk "<id>:T<hexByteLen>,<utf8 text>",
  // slicing by UTF-8 byte length (long synopses are shipped this way as $refs).
  function extractTextChunk(stream, id) {
    var re = new RegExp('(?:^|[\\n}\\]"])' + id + ':T([0-9a-fA-F]+),');
    var m = re.exec(stream);
    if (!m) return null;
    var need = parseInt(m[1], 16), start = m.index + m[0].length, bytes = 0, i = start;
    for (; i < stream.length && bytes < need; i++) {
      var c = stream.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { bytes += 4; i++; }
      else bytes += 3;
    }
    return stream.substring(start, i);
  }
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

  // The Directus proxy ignores filter params, so filtering and sorting happen
  // here over the full catalogue (a few hundred entries, one request).
  var BROWSE_FIELDS = ['date_created', 'last_updated', 'rating', 'rating_count', 'genres.genres_id.id'];
  Plugin.prototype.popularNovels = async function (page, options) {
    var opts = options || {}, f = opts.filters || {};
    var sort = opts.showLatestNovels ? '-last_updated' : ((f.sort && f.sort.value) || '-date_created');
    var wanted = (f.genres && f.genres.value) || [];
    if (sort === '-date_created' && !wanted.length) {
      var res = await directus('novels?fields=' + encodeURIComponent(NOVEL_FIELDS) +
        '&filter[status][_eq]=published&limit=24&page=' + page + '&sort=-date_created');
      return asList(res).filter(function (n) { return n.slug; }).map(mapNovel);
    }
    var fields = JSON.parse(NOVEL_FIELDS).concat(BROWSE_FIELDS);
    var all = asList(await directus('novels?fields=' + encodeURIComponent(JSON.stringify(fields)) +
      '&filter[status][_eq]=published&limit=-1')).filter(function (n) { return n.slug; });
    if (wanted.length) {
      all = all.filter(function (n) {
        return (n.genres || []).some(function (g) {
          return g && g.genres_id && wanted.indexOf(String(g.genres_id.id)) !== -1;
        });
      });
    }
    var key = sort.replace(/^-/, '');
    all.sort(function (a, b) {
      var x = a[key], y = b[key];
      if (typeof x === 'string' || typeof y === 'string') return String(y || '').localeCompare(String(x || ''));
      return (Number(y) || 0) - (Number(x) || 0);
    });
    return all.slice((page - 1) * 24, page * 24).map(mapNovel);
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (page > 1) return [];
    // The /api/directus proxy ignores filter/search params (returns the whole
    // catalog regardless), so pull the full (small) list and match titles here.
    var q = (searchTerm || '').toLowerCase();
    var res = await directus('novels?fields=' + encodeURIComponent(NOVEL_FIELDS) +
      '&limit=500&sort=novel_title');
    return asList(res).filter(function (n) {
      return n.slug && (n.novel_title || '').toLowerCase().indexOf(q) !== -1;
    }).map(mapNovel);
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var slug = slugOf(novelPath);
    novelPath = 'novels/' + slug;
    var html = await fetchApi(SITE + novelPath).then(function (r) { return r.text(); });
    var stream = rscStream(html);

    var name = (stream.match(/"novel_title":"((?:[^"\\]|\\.)*?)"/) || [])[1];
    try { name = JSON.parse('"' + (name || '') + '"'); } catch (e) {}
    var synopsis = (stream.match(/"synopsis":"((?:[^"\\]|\\.)*?)"/) || [])[1] || '';
    try { synopsis = JSON.parse('"' + synopsis + '"'); } catch (e) {}
    // Long synopses are shipped as a "$<id>" reference to a text chunk.
    var sref = synopsis.match(/^\$(\w+)$/);
    if (sref) synopsis = extractTextChunk(stream, sref[1]) ||
      (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    // cover: pull the raw Supabase storage url out of the page's image tags
    var cover = (html.match(/https:\/\/api\.genesistudio\.com\/storage\/v1\/object\/public\/directus\/[0-9a-f-]+\.\w+/) || [])[0];

    var raw = extractJsonArray(stream, 'initialChapters') || [];
    var chapters = raw.map(function (c) {
      var locked = (c.isPaid && !c.isUnlocked) || (c.tier && c.tier !== 'free' && !c.isUnlocked);
      var title = clean(c.chapter_title);
      return {
        name: (locked ? '🔒 ' : '') + 'Chapter ' + c.chapter_number +
          (title ? ': ' + title : ''),
        path: novelPath + '/chapter-' + c.chapter_number + '::' + c.id,
        chapterNumber: c.chapter_number,
      };
    });
    chapters.sort(function (a, b) { return (a.chapterNumber || 0) - (b.chapterNumber || 0); });

    return {
      name: clean(name) || slug,
      path: novelPath,
      cover: cover || defaultCover,
      summary: (synopsis || '').replace(/\r/g, '').trim(),
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var id = (String(chapterPath).match(/::(\d+)/) || [])[1] ||
      String(chapterPath).split('/').pop().replace(/[^0-9]/g, '');
    if (!id) return '';
    var res = await fetchApi(SITE + 'api/chapters/' + id + '/content', {
      headers: { 'Accept': 'application/json' },
    }).then(function (r) { return r.json(); });
    var d = (res && res.data) || {};
    if (!d.chapter_content) {
      return '<p><i>This chapter is locked (paid) and cannot be loaded '
        + 'without unlocking it on the site.</i></p>';
    }
    return d.chapter_content;
  };

  Plugin.prototype.resolveUrl = function (path) {
    return SITE + String(path).replace(/::\d+$/, '');
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
