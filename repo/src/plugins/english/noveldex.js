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

// noveldex.io is a Next.js App Router (RSC) site.
//   * Browse / search / novel-detail / chapter-list come from a clean JSON
//     REST API at /api/... plus the RSC-embedded "allChapters" array.
//   * The chapter body is delivered in an encoded form and decoded in-plugin
//     so it renders as normal text; the server also injects zero-width
//     characters (space/joiner/non-joiner, word-joiner) which are stripped.
//
// URLs:
//   novel page : /series/novel/<slug>            (redirect target of /series/<slug>)
//   chapter    : /series/novel/<slug>/chapter/<number>
//   listing API: /api/series?sort=views&page=<n>  -> {data:[...], meta:{...}}
//   search API : /api/search?q=<term>             -> {series:[...], ...}

var SITE = 'https://noveldex.io/';
var KEYLEN = 32;

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = 'noveldex';
    this.name = 'NovelDex-P';
    this.site = SITE;
    this.version = '1.1.0';
    this.icon = 'icons/noveldex.png';
    // Browse filters as the official LNReader noveldex plugin declares them
    // (lnreader-plugins plugins/v3.0.0@1e116f1); the JSON API takes the same params.
    this.filters = {
      "sort": {
        "label": "Sort By",
        "type": "Picker",
        "value": "views",
        "options": [
          {
            "label": "Recently Updated",
            "value": "updated"
          },
          {
            "label": "Most Bookmarked",
            "value": "popular"
          },
          {
            "label": "Most Viewed",
            "value": "views"
          },
          {
            "label": "Longest",
            "value": "longest"
          },
          {
            "label": "Trending",
            "value": "trending"
          },
          {
            "label": "Rating",
            "value": "rating"
          },
          {
            "label": "Newest",
            "value": "newest"
          }
        ]
      },
      "type": {
        "label": "Type",
        "type": "Checkbox",
        "value": [],
        "options": [
          {
            "label": "Novel",
            "value": "Novel"
          },
          {
            "label": "Light Novel",
            "value": "Light Novel"
          },
          {
            "label": "Web Novel",
            "value": "Web Novel"
          },
          {
            "label": "Published Novel",
            "value": "Published Novel"
          },
          {
            "label": "Fanfiction",
            "value": "Fanfiction"
          },
          {
            "label": "Original Fiction",
            "value": "Original Fiction"
          },
          {
            "label": "One Shot",
            "value": "One Shot"
          },
          {
            "label": "Manhwa",
            "value": "Manhwa"
          },
          {
            "label": "Manhua",
            "value": "Manhua"
          },
          {
            "label": "Manga",
            "value": "Manga"
          },
          {
            "label": "Webtoon",
            "value": "Webtoon"
          }
        ]
      },
      "status": {
        "label": "Status",
        "type": "Checkbox",
        "value": [],
        "options": [
          {
            "label": "Ongoing",
            "value": "Ongoing"
          },
          {
            "label": "Completed",
            "value": "Completed"
          },
          {
            "label": "Hiatus",
            "value": "Hiatus"
          },
          {
            "label": "Dropped",
            "value": "Dropped"
          },
          {
            "label": "Discontinued",
            "value": "Discontinued"
          },
          {
            "label": "Upcoming",
            "value": "Upcoming"
          }
        ]
      },
      "origin": {
        "label": "Origin",
        "type": "Checkbox",
        "value": [],
        "options": [
          {
            "label": "Korean",
            "value": "KOREAN"
          },
          {
            "label": "Japanese",
            "value": "JAPANESE"
          },
          {
            "label": "Chinese",
            "value": "CHINESE"
          },
          {
            "label": "Other",
            "value": "OTHER"
          }
        ]
      },
      "sale": {
        "label": "On Sale",
        "type": "Switch",
        "value": false
      },
      "images": {
        "label": "Illustrated",
        "type": "Switch",
        "value": false
      },
      "ch_min": {
        "label": "Min Chapters",
        "type": "Text",
        "value": ""
      },
      "ch_max": {
        "label": "Max Chapters",
        "type": "Text",
        "value": ""
      },
      "genre": {
        "label": "Genres",
        "type": "XCheckbox",
        "value": {
          "include": [],
          "exclude": []
        },
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
            "label": "Comedy",
            "value": "comedy"
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
            "label": "GameLit",
            "value": "gamelit"
          },
          {
            "label": "Gender Bender",
            "value": "gender-bender"
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
            "label": "Isekai",
            "value": "isekai"
          },
          {
            "label": "Josei",
            "value": "josei"
          },
          {
            "label": "LitRPG",
            "value": "litrpg"
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
            "label": "Military",
            "value": "military"
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
            "label": "Sci-Fi",
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
            "label": "Sports",
            "value": "sports"
          },
          {
            "label": "Supernatural",
            "value": "supernatural"
          },
          {
            "label": "Thriller",
            "value": "thriller"
          },
          {
            "label": "Tragedy",
            "value": "tragedy"
          },
          {
            "label": "Virtual Reality",
            "value": "virtual-reality"
          },
          {
            "label": "Wuxia",
            "value": "wuxia"
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
            "label": "Yaoi",
            "value": "yaoi"
          },
          {
            "label": "Yuri",
            "value": "yuri"
          }
        ]
      },
      "tag": {
        "label": "Tags",
        "type": "XCheckbox",
        "value": {
          "include": [],
          "exclude": []
        },
        "options": [
          {
            "label": "Male Protagonist",
            "value": "male-protagonist"
          },
          {
            "label": "Overpowered Protagonist",
            "value": "overpowered-protagonist"
          },
          {
            "label": "Modern Day",
            "value": "modern-day"
          },
          {
            "label": "Harem",
            "value": "harem"
          },
          {
            "label": "Misunderstandings",
            "value": "misunderstandings"
          },
          {
            "label": "Fantasy",
            "value": "fantasy"
          },
          {
            "label": "Academy",
            "value": "academy"
          },
          {
            "label": "Transmigration",
            "value": "transmigration"
          },
          {
            "label": "Fantasy World",
            "value": "fantasy-world"
          },
          {
            "label": "Magic",
            "value": "magic"
          },
          {
            "label": "Character Growth",
            "value": "character-growth"
          },
          {
            "label": "Obsessive Love",
            "value": "obsessive-love"
          },
          {
            "label": "Beautiful Female Lead",
            "value": "beautiful-female-lead"
          },
          {
            "label": "Modern Fantasy",
            "value": "modern-fantasy"
          },
          {
            "label": "Reincarnation",
            "value": "reincarnation"
          },
          {
            "label": "Game Elements",
            "value": "game-elements"
          },
          {
            "label": "Female Protagonist",
            "value": "female-protagonist"
          },
          {
            "label": "Action",
            "value": "action"
          },
          {
            "label": "Romance",
            "value": "romance"
          },
          {
            "label": "Survival",
            "value": "survival"
          },
          {
            "label": "Monsters",
            "value": "monsters"
          },
          {
            "label": "Possession",
            "value": "possession"
          },
          {
            "label": "Weak to Strong",
            "value": "weak-to-strong"
          },
          {
            "label": "R-18",
            "value": "r-18"
          },
          {
            "label": "Yandere",
            "value": "yandere"
          },
          {
            "label": "Adventure",
            "value": "adventure"
          },
          {
            "label": "19+",
            "value": "19-360615"
          },
          {
            "label": "Hunters",
            "value": "hunters"
          },
          {
            "label": "Special Abilities",
            "value": "special-abilities"
          },
          {
            "label": "Adult",
            "value": "adult"
          },
          {
            "label": "Dark Fantasy",
            "value": "dark-fantasy"
          },
          {
            "label": "Genius Protagonist",
            "value": "genius-protagonist"
          },
          {
            "label": "Calm Protagonist",
            "value": "calm-protagonist"
          },
          {
            "label": "Nobles",
            "value": "nobles"
          },
          {
            "label": "Gender Bender",
            "value": "gender-bender"
          },
          {
            "label": "System",
            "value": "system"
          },
          {
            "label": "Comedy",
            "value": "comedy"
          },
          {
            "label": "Light Novel",
            "value": "light-novel"
          },
          {
            "label": "Obsession",
            "value": "obsession"
          },
          {
            "label": "Dungeons",
            "value": "dungeons"
          },
          {
            "label": "Slice of Life",
            "value": "slice-of-life"
          },
          {
            "label": "Clever Protagonist",
            "value": "clever-protagonist"
          },
          {
            "label": "Drama",
            "value": "drama"
          },
          {
            "label": "Sword And Magic",
            "value": "sword-and-magic"
          },
          {
            "label": "Handsome Male Lead",
            "value": "handsome-male-lead"
          },
          {
            "label": "Aristocracy",
            "value": "aristocracy"
          },
          {
            "label": "Revenge",
            "value": "revenge"
          },
          {
            "label": "Male to Female",
            "value": "male-to-female"
          },
          {
            "label": "Adventurers",
            "value": "adventurers"
          },
          {
            "label": "Corruption",
            "value": "corruption"
          },
          {
            "label": "Second Chance",
            "value": "second-chance"
          },
          {
            "label": "Demons",
            "value": "demons"
          },
          {
            "label": "Mature",
            "value": "mature"
          },
          {
            "label": "Smut",
            "value": "smut"
          },
          {
            "label": "Pure Love",
            "value": "pure-love-978330"
          },
          {
            "label": "Regression",
            "value": "regression"
          },
          {
            "label": "Medieval",
            "value": "medieval"
          },
          {
            "label": "Politics",
            "value": "politics"
          },
          {
            "label": "Alternate World",
            "value": "alternate-world"
          },
          {
            "label": "Apocalypse",
            "value": "apocalypse"
          },
          {
            "label": "Accelerated Growth",
            "value": "accelerated-growth"
          },
          {
            "label": "Protagonist Strong from the Start",
            "value": "protagonist-strong-from-the-start"
          },
          {
            "label": "Martial Arts",
            "value": "martial-arts"
          },
          {
            "label": "Antihero Protagonist",
            "value": "antihero-protagonist"
          },
          {
            "label": "Heroes",
            "value": "heroes"
          },
          {
            "label": "Adapted to Manhwa",
            "value": "adapted-to-manhwa"
          },
          {
            "label": "Hard-Working Protagonist",
            "value": "hard-working-protagonist"
          },
          {
            "label": "Training",
            "value": "training"
          },
          {
            "label": "Ecchi",
            "value": "ecchi"
          },
          {
            "label": "Isekai",
            "value": "isekai"
          },
          {
            "label": "Royalty",
            "value": "royalty"
          },
          {
            "label": "Sword Wielder",
            "value": "sword-wielder"
          },
          {
            "label": "Urban Fantasy",
            "value": "urban-fantasy"
          },
          {
            "label": "Strong to Stronger",
            "value": "strong-to-stronger"
          },
          {
            "label": "Acting",
            "value": "acting"
          },
          {
            "label": "Regret",
            "value": "regret-728982"
          },
          {
            "label": "Supernatural",
            "value": "supernatural"
          },
          {
            "label": "Dark",
            "value": "dark"
          },
          {
            "label": "Betrayal",
            "value": "betrayal"
          },
          {
            "label": "Fantasy Creatures",
            "value": "fantasy-creatures"
          },
          {
            "label": "European Ambience",
            "value": "european-ambience"
          },
          {
            "label": "Schemes And Conspiracies",
            "value": "schemes-and-conspiracies"
          },
          {
            "label": "Level System",
            "value": "level-system"
          },
          {
            "label": "High Level",
            "value": "highlevel-008161"
          },
          {
            "label": "Romance Fantasy",
            "value": "romance-fantasy-578698"
          },
          {
            "label": "Live Streaming",
            "value": "livestreaming"
          },
          {
            "label": "Cunning Protagonist",
            "value": "cunning-protagonist"
          },
          {
            "label": "Gods",
            "value": "gods"
          },
          {
            "label": "Tragic Past",
            "value": "tragic-past"
          },
          {
            "label": "Incest",
            "value": "incest"
          },
          {
            "label": "Reincarnated in Another World",
            "value": "reincarnated-in-another-world"
          },
          {
            "label": "Hidden Identity",
            "value": "hidden-identity"
          },
          {
            "label": "Multiple POV",
            "value": "multiple-pov"
          },
          {
            "label": "First-time Intercourse",
            "value": "first-time-intercourse"
          },
          {
            "label": "Possessive Characters",
            "value": "possessive-characters"
          },
          {
            "label": "Transported into a Game World",
            "value": "transported-into-a-game-world"
          },
          {
            "label": "Hyundai",
            "value": "hyundai-025236"
          },
          {
            "label": "Kingdom Building",
            "value": "kingdom-building"
          },
          {
            "label": "Secret Identity",
            "value": "secret-identity"
          },
          {
            "label": "Tower Climbing",
            "value": "tower-climbing"
          },
          {
            "label": "Kingdoms",
            "value": "kingdoms"
          },
          {
            "label": "Military",
            "value": "military"
          },
          {
            "label": "Guilds",
            "value": "guilds"
          },
          {
            "label": "Netori",
            "value": "netori"
          },
          {
            "label": "Past Plays a Big Role",
            "value": "past-plays-a-big-role"
          },
          {
            "label": "Childhood Friends",
            "value": "childhood-friends"
          },
          {
            "label": "Ruthless Protagonist",
            "value": "ruthless-protagonist"
          },
          {
            "label": "Modern Knowledge",
            "value": "modern-knowledge"
          },
          {
            "label": "School Life",
            "value": "school-life"
          },
          {
            "label": "Hunter",
            "value": "hunter-343706"
          },
          {
            "label": "Slow Romance",
            "value": "slow-romance"
          },
          {
            "label": "Depictions of Cruelty",
            "value": "depictions-of-cruelty"
          },
          {
            "label": "Hidden Abilities",
            "value": "hidden-abilities"
          },
          {
            "label": "Strategist",
            "value": "strategist"
          },
          {
            "label": "Elves",
            "value": "elves"
          },
          {
            "label": "Modern",
            "value": "modern-943487"
          },
          {
            "label": "Hidden Power",
            "value": "hidden-power"
          },
          {
            "label": "Knights",
            "value": "knights"
          },
          {
            "label": "BDSM",
            "value": "bdsm"
          },
          {
            "label": "Determined Protagonist",
            "value": "determined-protagonist"
          }
        ]
      }
    };
  }

  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  Plugin.prototype.abs = function (u) {
    if (!u) return null;
    if (/^https?:/.test(u)) return u;
    return SITE + String(u).replace(/^\/+/, '');
  };
  Plugin.prototype.getPath = function (url) {
    url = this.abs(url);
    if (!url) return null;
    var host = SITE.replace(/^https?:\/\//, '');
    var u = url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
    if (u.indexOf(host) === 0) return u.substring(host.length).replace(/(^\/+|\/+$)/g, '');
    return null;
  };
  function slugOf(novelPath) {
    var m = String(novelPath).match(/series\/novel\/([^/]+)/);
    if (m) return m[1];
    return String(novelPath).replace(/^\/+|\/+$/g, '').split('/').pop();
  }

  // ---- RSC stream helpers -------------------------------------------------
  function rscStream(html) {
    var re = /__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g, m, out = '';
    while ((m = re.exec(html)) !== null) {
      try { out += JSON.parse('"' + m[1] + '"'); } catch (e) { out += m[1]; }
    }
    return out;
  }
  // Extract a React Flight text chunk "<id>:T<hexByteLen>,<utf8 text>",
  // slicing by UTF-8 byte length (walk code units summing byte widths).
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

  // ---- crypto: base64 -> bytes, break repeating XOR, UTF-8 decode ---------
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64I = (function () { var t = {}; for (var i = 0; i < B64.length; i++) t[B64[i]] = i; return t; })();
  function b64ToBytes(str) {
    str = String(str).replace(/[^A-Za-z0-9+/]/g, '');
    var out = [], i = 0, n = str.length;
    while (i < n) {
      var e0 = B64I[str[i++]], e1 = B64I[str[i++]],
          e2 = i <= n ? B64I[str[i++]] : undefined,
          e3 = i <= n ? B64I[str[i++]] : undefined;
      var c0 = (e0 << 2) | (e1 >> 4);
      out.push(c0 & 0xff);
      if (e2 !== undefined) { out.push(((e1 & 15) << 4 | (e2 >> 2)) & 0xff); }
      if (e3 !== undefined) { out.push(((e2 & 3) << 6 | e3) & 0xff); }
    }
    return out;
  }
  function utf8BytesToStr(bytes) {
    var out = '', i = 0, n = bytes.length;
    while (i < n) {
      var b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b >= 0xC0 && b < 0xE0) {
        out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
      } else if (b >= 0xE0 && b < 0xF0) {
        out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      } else if (b >= 0xF0) {
        var cp = ((b & 7) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3ff));
      } // lone continuation bytes are skipped
    }
    return out;
  }
  // Score a candidate plaintext byte for "English HTML" likelihood.
  function scoreByte(b) {
    if (b === 0x20) return 8;                 // space
    if (b >= 0x61 && b <= 0x7a) return 6;     // a-z
    if (b >= 0x41 && b <= 0x5a) return 3;     // A-Z
    if (b === 0x2e || b === 0x2c || b === 0x3c || b === 0x3e || b === 0x2f ||
        b === 0x0a || b === 0x22 || b === 0x27) return 2;   // . , < > / \n " '
    if (b >= 0x30 && b <= 0x39) return 1;     // digits
    if (b >= 0x20 && b < 0x7f) return 0;      // other printable ASCII
    return -3;                                // non-ASCII (rare / scramble)
  }
  function decryptChapter(b64) {
    var bytes = b64ToBytes(b64);
    if (!bytes.length) return '';
    var key = new Array(KEYLEN);
    for (var c = 0; c < KEYLEN; c++) {
      var best = -1e9, bk = 0;
      for (var k = 0; k < 256; k++) {
        var sc = 0;
        for (var i = c; i < bytes.length; i += KEYLEN) sc += scoreByte(bytes[i] ^ k);
        if (sc > best) { best = sc; bk = k; }
      }
      key[c] = bk;
    }
    var dec = new Array(bytes.length);
    for (var j = 0; j < bytes.length; j++) dec[j] = bytes[j] ^ key[j % KEYLEN];
    // Strip invisible DOM-scramble characters (ZWSP/ZWNJ/ZWJ/word-joiner/
    // BOM/LRM/RLM), keep real punctuation like em-dashes and curly quotes.
    return utf8BytesToStr(dec)
      .replace(/[\u200B\u200C\u200D\u2060\uFEFF\u200E\u200F]/g, '');
  }

  // ---- API ----------------------------------------------------------------
  function apiJson(path) {
    return fetchApi(SITE + 'api/' + path, {
      headers: { 'Accept': 'application/json', 'Referer': SITE },
    }).then(function (r) { return r.json(); });
  }
  Plugin.prototype.mapSeries = function (b) {
    var slug = b.urlSlug || b.slug;
    return {
      name: clean(b.title),
      path: 'series/novel/' + slug,
      cover: b.coverImage ? this.abs(b.coverImage) : defaultCover,
    };
  };

  // Query string for /api/series from the filter values: excludable groups
  // become include/exclude lists, multi-selects comma lists, switches 'true'.
  function seriesQuery(f) {
    var q = '';
    var add = function (k, v) { q += '&' + k + '=' + encodeURIComponent(v); };
    var ex = function (v, inc, exc) {
      if (v && v.include && v.include.length) add(inc, v.include.join(','));
      if (v && v.exclude && v.exclude.length) add(exc, v.exclude.join(','));
    };
    f = f || {};
    ex(f.genre && f.genre.value, 'genre', 'exgenre');
    ex(f.tag && f.tag.value, 'tag', 'extag');
    ['type', 'status', 'origin'].forEach(function (k) {
      var v = f[k] && f[k].value;
      if (v && v.length) add(k, v.join(','));
    });
    if (f.sale && f.sale.value) add('sale', 'true');
    if (f.images && f.images.value) add('images', 'true');
    ['ch_min', 'ch_max'].forEach(function (k) {
      var v = f[k] && String(f[k].value || '').trim();
      if (v) add(k, v);
    });
    return q;
  }
  Plugin.prototype.popularNovels = async function (page, options) {
    var opts = options || {}, f = opts.filters || {};
    var sort = opts.showLatestNovels ? 'latest' : ((f.sort && f.sort.value) || 'views');
    var res = await apiJson('series?sort=' + sort + '&page=' + page + seriesQuery(f));
    var data = (res && res.data) || [];
    var self = this;
    return data.map(function (b) { return self.mapSeries(b); });
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (page > 1) return [];
    var res = await apiJson('search?q=' + encodeURIComponent(searchTerm));
    var list = (res && res.series) || [];
    var self = this;
    return list.map(function (b) { return self.mapSeries(b); });
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var slug = slugOf(novelPath);
    novelPath = 'series/novel/' + slug;
    // Novel page: synopsis + title via meta tags.
    var body = await fetchApi(SITE + novelPath).then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var name = clean($('meta[property="og:title"]').attr('content') ||
      $('h1').first().text());
    var summary = clean($('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') || '');

    // Full chapter list + clean cover come from chapter 1's RSC payload
    // ("allChapters" is complete; the novel page caps "chapters" at 100).
    var cover = '';
    var chapters = [];
    try {
      var chHtml = await fetchApi(SITE + novelPath + '/chapter/1')
        .then(function (r) { return r.text(); });
      var stream = rscStream(chHtml);
      var sm = stream.match(/"series":\{[^{}]*?"coverImage":"([^"]*)"/);
      if (sm && sm[1]) cover = this.abs(sm[1]);
      var all = extractJsonArray(stream, 'allChapters') || [];
      chapters = all.map(function (c) {
        var locked = c.isLocked || (c.coinPrice > 0 && c.hasAccess === false);
        return {
          name: (locked ? '🔒 ' : '') + (clean(c.title) || ('Chapter ' + c.number)),
          path: novelPath + '/chapter/' + c.number,
          chapterNumber: c.number,
        };
      });
    } catch (e) {}

    // Fallback: novel-page "chapters" array if chapter 1 was unavailable.
    if (!chapters.length) {
      var stream2 = rscStream(body);
      var raw = extractJsonArray(stream2, 'chapters') || [];
      chapters = raw.map(function (c) {
        var locked = c.isLocked || c.coinPrice > 0;
        return {
          name: (locked ? '🔒 ' : '') + (clean(c.title) || ('Chapter ' + c.number)),
          path: novelPath + '/chapter/' + c.number,
          chapterNumber: c.number,
        };
      });
    }
    chapters.sort(function (a, b) { return (a.chapterNumber || 0) - (b.chapterNumber || 0); });
    if (!cover) {
      var cm = rscStream(body).match(/"coverImage":"([^"]+)"/);
      cover = cm ? this.abs(cm[1]) : defaultCover;
    }

    return {
      name: name || slug,
      path: novelPath,
      cover: cover || defaultCover,
      summary: summary,
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(SITE + chapterPath).then(function (r) { return r.text(); });
    var stream = rscStream(body);
    var ref = stream.match(/"encryptedBase64":"\$(\w+)"/);
    var b64 = null;
    if (ref) {
      b64 = extractTextChunk(stream, ref[1]);
    } else {
      // content may be inline for very short chapters
      var inl = stream.match(/"encryptedBase64":"((?:[^"\\]|\\.){40,}?)"/);
      if (inl) { try { b64 = JSON.parse('"' + inl[1] + '"'); } catch (e) {} }
    }
    if (!b64) {
      return '<p><i>This chapter is locked (paid) and cannot be loaded '
        + 'without a subscription.</i></p>';
    }
    var html = decryptChapter(b64);
    return html || '';
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
