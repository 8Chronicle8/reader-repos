#!/usr/bin/env python3
"""
lnrepo v2 - generate a custom LNReader plugin repository from ANY novel site.

Commands:
  add <url>     analyze a site and generate a plugin (auto engine detection)
  probe <url>   analyze only; print what was inferred (debugging)
  build         write plugins.min.json      (--github user/repo [--branch main])
  list          list added plugins

Engines (auto-detected, each validates itself and falls back to `universal`):
  madara | lightnovelwp | wpblog | blogspot | universal

`universal` infers selectors by structural analysis:
  listing cards -> novel page -> chapter list -> chapter content (text density)
and bakes them into a plugin whose runtime ALSO carries generic fallbacks,
so imperfect inference still degrades gracefully.

Escape hatch for Cloudflare-guarded sites (can't be probed from here):
  add <url> --engine universal --config mysite.json     # hand-written selectors
"""

import argparse, io, json, os, re, struct, sys, urllib.request, zlib
from collections import Counter
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.join(ROOT, "repo")
PLUGINS_DIR = os.path.join(REPO_DIR, "plugins")
ICONS_DIR = os.path.join(REPO_DIR, "icons")
STATE_FILE = os.path.join(REPO_DIR, "sources.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

CH_TEXT_RX = re.compile(
    r"(chapter|chap\.?\s*\d|\bch\.?\s*\d|episode|\bep\.?\s*\d|"
    r"第\s*\d+\s*[章话話回]|\bvol\.?\s*\d+.*\bc\d|\bpart\s+\d)", re.I)
CH_URL_RX = re.compile(
    r"(chapter|/ch[-_/]?\d|[-_/]c\d{1,5}([\-/.]|$)|episode|/ep[-_]?\d)", re.I)

# ------------------------------------------------------------ http helpers

def http_get(url, timeout=25, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", errors="replace")

def try_get(url):
    try:
        return http_get(url)
    except Exception:
        return None

def http_json(url):
    try:
        return json.loads(http_get(url))
    except Exception:
        return None

def slugify(t):
    return re.sub(r"[^a-z0-9]+", "", t.lower()) or "plugin"

# ------------------------------------------------------------ mini DOM

VOID = {"img","br","meta","link","input","hr","source","area","base","col",
        "embed","param","track","wbr"}

class Node:
    __slots__ = ("tag","attrs","children","parent","texts")
    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children, self.texts = [], []
    @property
    def classes(self):
        return (self.attrs.get("class") or "").split()
    def own_text(self):
        return " ".join(self.texts)
    def text(self):
        out = [self.own_text()]
        for c in self.children:
            out.append(c.text())
        return re.sub(r"\s+", " ", " ".join(out)).strip()
    def iter(self):
        yield self
        for c in self.children:
            yield from c.iter()
    def find_all(self, tag):
        return [n for n in self.iter() if n.tag == tag]

class DomParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("[document]", [], None)
        self.cur = self.root
        self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in ("script","style","noscript","template"):
            self.skip += 1; return
        n = Node(tag, attrs, self.cur)
        self.cur.children.append(n)
        if tag not in VOID:
            self.cur = n
    def handle_startendtag(self, tag, attrs):
        if self.skip: return
        self.cur.children.append(Node(tag, attrs, self.cur))
    def handle_endtag(self, tag):
        if tag in ("script","style","noscript","template"):
            self.skip = max(0, self.skip - 1); return
        c = self.cur
        while c is not None and c.tag != tag:
            c = c.parent
        if c is not None and c.parent is not None:
            self.cur = c.parent
    def handle_data(self, data):
        if not self.skip and data.strip():
            self.cur.texts.append(data.strip())

def parse_dom(html):
    p = DomParser()
    try:
        p.feed(html)
    except Exception:
        pass
    return p.root

def css_path(node, max_parts=3):
    parts, cur = [], node
    while cur is not None and cur.tag not in ("[document]","html","body") \
            and len(parts) < max_parts:
        nid = cur.attrs.get("id", "")
        if re.match(r"^[A-Za-z][\w-]*$", nid):
            parts.append(f"{cur.tag}#{nid}")
            break
        cls = next((c for c in cur.classes
                    if re.match(r"^[A-Za-z][\w-]*$", c) and len(c) > 1), None)
        parts.append(f"{cur.tag}.{cls}" if cls else cur.tag)
        cur = cur.parent
    return " ".join(reversed(parts))

# ------------------------------------------------------------ analyzer

class Analyzer:
    """Structural inference for the `universal` engine."""

    def __init__(self, site):
        self.site = site
        self.host = urlparse(site).netloc

    def abs(self, href, base=None):
        return urljoin(base or self.site, href)

    def path_of(self, url):
        u = urlparse(url)
        if u.netloc and u.netloc != self.host:
            return None
        return u.path.lstrip("/") + (("?" + u.query) if u.query else "")

    # ---- listing ----
    def card_groups(self, dom):
        """Group <a><img> card patterns by their parent's css path."""
        groups = Counter()
        sample = {}
        for a in dom.find_all("a"):
            href = a.attrs.get("href")
            if not href or href.startswith(("#","javascript","mailto")):
                continue
            if self.path_of(self.abs(href)) is None:
                continue
            if not a.find_all("img") and not (
                    a.parent and a.parent.find_all("img")):
                continue
            parent = a.parent
            if parent is None:
                continue
            key = css_path(parent)
            if not key:
                continue
            groups[key] += 1
            sample.setdefault(key, self.abs(a.attrs["href"]))
        return groups, sample

    def _check_pagination(self, url, sel, first_href):
        """A page-2 URL only counts if it shows DIFFERENT cards than page 1
        (many sites silently ignore unknown params and re-serve page 1)."""
        for cand in [url + ("&" if "?" in url else "?") + "page=2",
                     url.rstrip("/") + "/page/2/"]:
            h2 = try_get(cand)
            if not h2:
                continue
            g2, s2 = self.card_groups(parse_dom(h2))
            if g2.get(sel, 0) >= 3 and s2.get(sel) and s2.get(sel) != first_href:
                if cand.endswith("page=2"):
                    return cand[:-1] + "{page}"
                return cand.replace("/page/2/", "/page/{page}/")
        return None

    def find_listing(self, home_html):
        paths = ["", "novel-list", "list/all", "most-popular", "sort/popular",
                 "fictions/best-rated", "series", "novels", "browse",
                 "library", "ranking", "genre/all"]
        found = []
        for path in paths:
            url = self.site + path
            html = home_html if path == "" else try_get(url)
            if not html:
                continue
            groups, sample = self.card_groups(parse_dom(html))
            if not groups:
                continue
            sel, cnt = groups.most_common(1)[0]
            if cnt >= 4:
                found.append({"url": url, "item": sel, "count": cnt,
                              "sampleNovel": sample[sel]})
        if not found:
            return None
        found.sort(key=lambda f: -f["count"])
        for f in found[:3]:
            f["pageUrl"] = self._check_pagination(f["url"], f["item"],
                                                  f["sampleNovel"])
        best = sorted(found[:3],
                      key=lambda f: (f["pageUrl"] is None, -f["count"]))[0]
        best["sampleNovel"] = best["sampleNovel"].split("#")[0].split("?")[0]
        return best

    # ---- novel page ----
    def analyze_novel(self, novel_url):
        html = try_get(novel_url)
        if not html:
            return None, None
        dom = parse_dom(html)
        novel_path = self.path_of(novel_url) or ""

        # chapter container = element with most chapter-looking anchors
        best, best_cnt, first_ch, nums = None, 0, None, []
        for node in dom.iter():
            if node.tag in ("a","[document]","html","body","script"):
                continue
            hits, local_nums, local_first = 0, [], None
            for a in node.find_all("a"):
                href = a.attrs.get("href")
                if not href:
                    continue
                full = self.abs(href, novel_url)
                p = self.path_of(full)
                if p is None:
                    continue
                t = a.text()
                if CH_TEXT_RX.search(t) or CH_URL_RX.search("/" + p):
                    hits += 1
                    if local_first is None:
                        local_first = full
                    m = re.search(r"(\d+(?:\.\d+)?)", t) or \
                        re.search(r"(\d+(?:\.\d+)?)", p)
                    if m:
                        local_nums.append(float(m.group(1)))
            # prefer the *smallest* container holding the max links
            if hits > best_cnt or (hits == best_cnt and hits and
                                   best and node in list(best.iter())):
                best, best_cnt, first_ch, nums = node, hits, local_first, local_nums

        chapters_sel = css_path(best) if best is not None and best_cnt >= 3 else None
        reverse = bool(nums and len(nums) >= 2 and nums[0] > nums[-1])

        # chapter-list pagination on the novel page
        ch_pag = None
        base = novel_path.split("?")[0]
        for a in dom.find_all("a"):
            href = a.attrs.get("href") or ""
            p = self.path_of(self.abs(href, novel_url))
            if not p or not base or not p.startswith(base):
                continue
            if re.search(r"(\?|&)page=\d+|/page/\d+", p):
                suffix = re.sub(r"((\?|&)page=)\d+", r"\g<1>{page}",
                                re.sub(r"/page/\d+/?", "/page/{page}/",
                                       p[len(base):]))
                if suffix.startswith(("?", "/", "&")):
                    ch_pag = suffix
                break

        title_sel = None
        tm = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
        page_title = (tm.group(1) if tm else "").lower()
        heads = dom.find_all("h1") + dom.find_all("h2") + dom.find_all("h3")
        for h in heads:
            t = h.text()
            if t and len(t) > 2 and (not page_title
                                     or t.lower()[:40] in page_title):
                title_sel = css_path(h)
                break
        if not title_sel:
            for h in heads:
                if h.text():
                    title_sel = css_path(h)
                    break

        summary_sel, summary_len = None, 10 ** 9
        for node in dom.iter():
            joined = " ".join(node.classes).lower()
            if re.search(r"(summ|desc|synop)", joined):
                tl = len(node.text())
                if 60 < tl < summary_len:
                    summary_sel, summary_len = css_path(node), tl

        cfg = {"title": [title_sel] if title_sel else [],
               "summary": [summary_sel] if summary_sel else [],
               "chapters": {"container": [chapters_sel] if chapters_sel else [],
                            "reverse": reverse,
                            "pagination": ch_pag},
               "_chapterCount": best_cnt}
        return cfg, first_ch

    # ---- chapter page ----
    def analyze_chapter(self, ch_url):
        html = try_get(ch_url)
        if not html:
            return None, 0
        dom = parse_dom(html)
        best, best_score, best_len = None, 0, 0
        for node in dom.iter():
            if node.tag not in ("div","article","section","main","td"):
                continue
            t = len(node.text())
            if t < 400:
                continue
            link_t = sum(len(a.text()) for a in node.find_all("a"))
            p_cnt = len([c for c in node.children if c.tag == "p"])
            depth_pen = 8 * len([n for n in node.iter()
                                 if n.tag in ("div","section","article")])
            score = t - 1.3 * link_t + 25 * p_cnt - depth_pen
            if score > best_score:
                best, best_score, best_len = node, score, t
        if best is None:
            return None, 0
        # descend while one child holds nearly all the text
        while True:
            kids = [c for c in best.children
                    if c.tag in ("div","section","article")]
            moved = False
            for k in kids:
                if len(k.text()) >= 0.9 * len(best.text()):
                    best, moved = k, True
                    break
            if not moved:
                break
        return css_path(best), best_len

    # ---- search ----
    def find_search(self, sample_title, sample_path, home_html=None):
        words = [w for w in re.sub(r"[^\w\s]", " ", sample_title).split()
                 if len(w) >= 4]
        if not words:
            return None
        q = words[0]
        needle = sample_path.split("?")[0].rstrip("/").split("/")[-1]
        for pat in ["search?keyword={query}", "search?q={query}",
                    "search?title={query}", "fictions/search?title={query}",
                    "search/{query}", "search.html?searchkey={query}",
                    "?searchkey={query}", "?s={query}"]:
            html = try_get(self.site + pat.replace("{query}", q))
            if not html or not needle or needle not in html:
                continue
            if home_html and html[:2500] == home_html[:2500]:
                continue  # site ignored the param and re-served the homepage
            return self.site + pat
        return None

    # ---- orchestrate ----
    def run(self):
        home = try_get(self.site)
        if home is None:
            raise RuntimeError(
                "Site unreachable from here (Cloudflare/anti-bot?). "
                "Use --config with hand-written selectors.")
        report = {}
        listing = self.find_listing(home)
        cfg = {"listing": {}, "novel": {}, "chapter": {}, "search": {}}
        sample_novel = None
        if listing:
            cfg["listing"] = {"url": listing["url"],
                              "pageUrl": listing["pageUrl"],
                              "item": [listing["item"]]}
            sample_novel = listing["sampleNovel"]
            report["listing"] = f"{listing['count']} cards @ {listing['url']}"
        else:
            report["listing"] = "NOT FOUND (popularNovels will be empty; " \
                                "edit CONFIG.listing manually)"

        first_ch, title_txt = None, ""
        if sample_novel:
            ncfg, first_ch = self.analyze_novel(sample_novel)
            if ncfg:
                cfg["novel"] = {k: v for k, v in ncfg.items()
                                if not k.startswith("_")}
                report["novel"] = (f"{ncfg['_chapterCount']} chapter links "
                                   f"@ {sample_novel}")
                d = parse_dom(try_get(sample_novel) or "")
                h1 = d.find_all("h1")
                title_txt = h1[0].text() if h1 else ""
        if first_ch:
            sel, clen = self.analyze_chapter(first_ch)
            if sel:
                cfg["chapter"] = {"content": [sel]}
                report["chapter"] = f"{clen} chars via `{sel}`"
            else:
                report["chapter"] = "no dense container found; runtime " \
                                    "readability fallback will be used"
        if title_txt and sample_novel:
            surl = self.find_search(title_txt,
                                    self.path_of(sample_novel) or "", home)
            cfg["search"] = {"url": surl}
            report["search"] = surl or "none found (falls back to filtering)"
        return cfg, report

# ------------------------------------------------------------ misc assets

def placeholder_png():
    w = h = 48
    row = b"\x00" + b"\x80\x80\x90" * w
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + \
               struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(row * h)) + chunk(b"IEND", b""))

class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.icons = [], []
        self._href, self._buf = None, []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self._href, self._buf = a["href"], []
        elif tag == "link" and "icon" in (a.get("rel") or "").lower() \
                and a.get("href"):
            self.icons.append(a["href"])
    def handle_data(self, d):
        if self._href is not None:
            self._buf.append(d)
    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append(
                (self._href, re.sub(r"\s+", " ", "".join(self._buf)).strip()))
            self._href = None

def grab_icon(site, html, dest):
    p = LinkParser()
    try: p.feed(html)
    except Exception: pass
    cands = [urljoin(site, u) for u in p.icons] + \
            [urljoin(site, "/apple-touch-icon.png"), urljoin(site, "/favicon.ico")]
    for url in cands:
        try:
            data = http_get(url, binary=True)
            if len(data) < 50: continue
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                open(dest, "wb").write(data); return True
            try:
                from PIL import Image
                Image.open(io.BytesIO(data)).convert("RGBA").save(dest, "PNG")
                return True
            except Exception:
                continue
        except Exception:
            continue
    open(dest, "wb").write(placeholder_png())
    return False

BLACKLIST_SLUGS = {"", "about","contact","contact-us","privacy-policy","privacy",
    "disclaimer","dmca","faq","donate","projects","home","blog","terms",
    "terms-of-service","sitemap"}

def discover_wpblog_novels(site, html):
    p = LinkParser(); p.feed(html)
    host = urlparse(site).netloc
    seen, out = set(), []
    for href, text in p.links:
        full = urljoin(site, href); u = urlparse(full)
        if u.netloc != host: continue
        path = u.path.strip("/")
        last = path.split("/")[-1] if path else ""
        if not path or last in BLACKLIST_SLUGS or path in seen: continue
        if re.match(r"^(archives?|category|tag|page|author|\d{4})(/|$)", path):
            continue
        if path.count("/") > 2: continue
        seen.add(path)
        data = http_json(f"{site}wp-json/wp/v2/pages?slug={last}")
        if not data or not isinstance(data, list) or len(data) != 1: continue
        content = data[0].get("content", {}).get("rendered", "")
        n = len(re.findall(r'href="https?://%s/' % re.escape(host), content))
        if n < 5: continue
        m = re.search(r'<img[^>]+(?:data-lazy-src|src)="([^"]+)"', content)
        title = re.sub(r"<[^>]+>", "",
                       data[0].get("title", {}).get("rendered", "")) or text
        out.append({"name": title.strip(), "path": path,
                    "cover": m.group(1) if m else ""})
        print(f"    + novel: {title.strip()}  ({path}, {n} links)")
    return out

# ------------------------------------------------------------ JS templates
# Token replacement (__ID__ etc.) instead of f-strings: JS braces stay sane.

COMMON_HEAD = """Object.defineProperty(exports, "__esModule", { value: true });
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
"""

TPL_UNIVERSAL = COMMON_HEAD + r"""
// Inferred by lnrepo. Every selector list is a fallback chain -- edit freely.
var CONFIG = __CONFIG__;

var GENERIC_ITEMS = ['article', '.book-item', '.novel-item', '.list-novel .row',
  '.fiction-list-item', 'li.novel-item', '.item'];
var GENERIC_TITLE = ['h1', '.novel-title', '.book-name', '.title'];
var GENERIC_SUMMARY = ['[class*="summ"]', '[class*="desc"]', '[class*="synop"]',
  '.entry-content'];
var GENERIC_COVER = ['.book img', '.novel-cover img', '.cover img',
  '.summary_image img', '.fic-header img', '.thumbnail img', 'img.cover',
  '.img-cover img', '.sertothumb img', '.novel-thumb img'];
var GENERIC_CONTENT = ['#chapter-content', '.chapter-content', '#chr-content',
  '.chapter-c', '.reading-content', '.entry-content', '.epcontent',
  '#content', '.content'];

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = '__ID__';
    this.name = '__NAME__';
    this.site = '__SITE__';
    this.version = '__VERSION__';
    this.icon = 'icons/__ID__.png';
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
    if (u.indexOf(host) !== 0) return null;
    u = u.replace(/#.*$/, '')
      .replace(/([?&])utm_[^&#]*/g, '$1')
      .replace(/[?&]+$/, '').replace(/\?&/, '?');
    return u.substring(host.length).replace(/^\/+/, '');
  };
  function imgSrc(img) {
    if (!img || !img.length) return null;
    return img.attr('data-src') || img.attr('data-lazy-src') ||
      img.attr('data-original') || img.attr('src') ||
      (img.attr('srcset') || '').split(' ')[0] || null;
  }
  function firstMatch($, sels) {
    for (var i = 0; i < sels.length; i++) {
      if (!sels[i]) continue;
      var el = $(sels[i]).first();
      if (el.length) return el;
    }
    return null;
  }
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function chNum(name, path) {
    var m = (name || '').match(/(?:chapter|chap|ch|episode|ep|c)[^0-9]{0,3}(\d+(?:\.\d+)?)/i) ||
      (path || '').match(/(?:chapter|ch|c|ep)[-_/]?(\d+(?:\.\d+)?)/i) ||
      (name || '').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  Plugin.prototype.parseItems = function ($) {
    var self = this;
    var sels = (CONFIG.listing.item || []).concat(GENERIC_ITEMS);
    var novels = [], seen = {};
    for (var i = 0; i < sels.length; i++) {
      $(sels[i]).each(function () {
        var it = $(this);
        var a = it.find('a[href]').first();
        if (!a.length && it.is('a')) a = it;
        var path = a.length ? self.getPath(a.attr('href')) : null;
        if (!path || seen[path]) return;
        var name = a.attr('title') ||
          clean(it.find('h1,h2,h3,h4,h5,.title,.tt,.novel-title').first().text()) ||
          it.find('img').attr('alt') || clean(a.text());
        if (!name) return;
        seen[path] = 1;
        novels.push({ name: clean(name), path: path,
          cover: self.abs(imgSrc(it.find('img').first())) || defaultCover });
      });
      if (novels.length >= 3) break;
      novels = []; seen = {};
    }
    if (!novels.length) novels = this.inferItems($);
    return novels;
  };

  Plugin.prototype.inferItems = function ($) {
    // structural fallback: largest group of <a><img> cards, like the analyzer
    var self = this;
    var groups = {};
    $('a[href]').each(function () {
      var a = $(this);
      var path = self.getPath(a.attr('href'));
      if (!path) return;
      if (CH_URL.test('/' + path)) return; // chapter link, not a novel card
      var card = a.closest('li,tr,article');
      if (!card.length || !card.find('img').length) {
        card = a.parents('div').filter(function () {
          return $(this).find('img').length > 0;
        }).first();
      }
      if (!card.length) return;
      if (card.find('a[href]').length > 8) return; // container, not a card
      var key = card.prop('tagName') + '.' +
        ((card.attr('class') || '').split(/\s+/)[0] || '');
      (groups[key] = groups[key] || []).push({ a: a, card: card });
    });
    var bestKey = null, bestLen = 0;
    for (var k in groups) {
      if (groups[k].length > bestLen) { bestLen = groups[k].length; bestKey = k; }
    }
    if (!bestKey || bestLen < 3) return [];
    var novels = [], seen = {};
    groups[bestKey].forEach(function (pair) {
      var a = pair.a, card = pair.card;
      var path = self.getPath(a.attr('href'));
      if (!path || seen[path]) return;
      var name = a.attr('title') || card.find('img').attr('alt') ||
        clean(card.find('h1,h2,h3,h4,h5,.title,.tt').first().text()) ||
        clean(a.text());
      if (!name) return;
      seen[path] = 1;
      novels.push({ name: clean(name), path: path,
        cover: self.abs(imgSrc(card.find('img').first())) || defaultCover });
    });
    return novels;
  };

  Plugin.prototype.popularNovels = async function (page, options) {
    var url;
    if (CONFIG.listing.pageUrl) {
      url = CONFIG.listing.pageUrl.replace('{page}', page);
    } else {
      if (page !== 1) return [];
      url = CONFIG.listing.url;
    }
    if (!url) return [];
    var body = await fetchApi(url).then(function (r) { return r.text(); });
    return this.parseItems(cheerio.load(body));
  };

  Plugin.prototype.harvestChapters = function ($, scope, novelPath) {
    var self = this;
    var chapters = [], seen = {};
    scope.find('a[href]').each(function () {
      var a = $(this);
      var path = self.getPath(a.attr('href'));
      if (!path) return;
      var name = clean(a.text()) || a.attr('title') || '';
      if (!CH_TEXT.test(name) && !CH_URL.test('/' + path)) return;
      if (path.replace(/[?#].*/, '') === novelPath.replace(/[?#].*/, '')) return;
      if (seen[path]) {
        // duplicate link to the same chapter: keep the longer name
        if (name.length > seen[path].name.length) seen[path].name = name;
        return;
      }
      var entry = { name: name || path, path: path };
      seen[path] = entry;
      chapters.push(entry);
    });
    return chapters;
  };
  var CH_TEXT = /(chapter|chap\.?\s*\d|\bch\.?\s*\d|episode|\bep\.?\s*\d|第\s*\d+\s*[章话話回]|\bpart\s+\d)/i;
  var CH_URL = /(chapter|\/ch[-_/]?\d|[-_/]c\d{1,5}([\-/.]|$)|episode|\/ep[-_]?\d)/i;

  Plugin.prototype.parseNovel = async function (novelPath) {
    var self = this;
    var body = await fetchApi(this.site + novelPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);

    var titleEl = firstMatch($, (CONFIG.novel.title || []).concat(GENERIC_TITLE));
    var name = titleEl ? clean(titleEl.text()) : '';
    if (!name) name = clean($('meta[property="og:title"]').attr('content') || '');
    var cover = null;
    var covEl = firstMatch($, (CONFIG.novel.cover || []).concat(GENERIC_COVER));
    if (covEl) cover = imgSrc(covEl.is('img') ? covEl : covEl.find('img').first());
    if (!cover) cover = $('meta[property="og:image"]').attr('content');
    if (!cover && titleEl) {
      cover = imgSrc(titleEl.closest('div,section,article,header')
        .find('img').first());
    }
    var sumEl = firstMatch($, (CONFIG.novel.summary || []).concat(GENERIC_SUMMARY));

    var chapters = [];
    var contSels = (CONFIG.novel.chapters && CONFIG.novel.chapters.container) || [];
    for (var i = 0; i < contSels.length && !chapters.length; i++) {
      var cont = $(contSels[i]).first();
      if (cont.length) chapters = this.harvestChapters($, cont, novelPath);
    }
    if (!chapters.length) chapters = this.harvestChapters($, $('body'), novelPath);

    // follow chapter-list pagination if inference found one
    var pag = CONFIG.novel.chapters && CONFIG.novel.chapters.pagination;
    if (pag) {
      for (var p = 2; p <= 150; p++) {
        var suffix = pag.replace('{page}', p);
        if (suffix.charAt(0) === '?' && novelPath.indexOf('?') !== -1) {
          suffix = '&' + suffix.slice(1);
        }
        var pb = await fetchApi(this.site + novelPath + suffix)
          .then(function (r) { return r.text(); }).catch(function () { return ''; });
        if (!pb) break;
        var $$ = cheerio.load(pb);
        var more = [];
        for (var j = 0; j < contSels.length && !more.length; j++) {
          var c2 = $$(contSels[j]).first();
          if (c2.length) more = this.harvestChapters($$, c2, novelPath);
        }
        if (!more.length) more = this.harvestChapters($$, $$('body'), novelPath);
        var before = chapters.length;
        var have = {};
        chapters.forEach(function (c) { have[c.path] = 1; });
        more.forEach(function (c) { if (!have[c.path]) chapters.push(c); });
        if (chapters.length === before) break;
      }
    }

    // order: numeric ascending when most chapters carry numbers
    var nums = chapters.map(function (c) { return chNum(c.name, c.path); });
    var withN = nums.filter(function (n) { return n !== null; }).length;
    if (chapters.length > 3 && withN >= chapters.length * 0.6) {
      chapters = chapters.map(function (c, i) { return [nums[i], i, c]; })
        .sort(function (a, b) {
          var x = a[0] === null ? 1e12 : a[0], y = b[0] === null ? 1e12 : b[0];
          return x - y || a[1] - b[1];
        }).map(function (t) { return t[2]; });
    } else if (CONFIG.novel.chapters && CONFIG.novel.chapters.reverse) {
      chapters.reverse();
    }

    return {
      name: name || novelPath,
      path: novelPath,
      cover: this.abs(cover) || defaultCover,
      summary: sumEl ? clean(sumEl.text()) : '',
      chapters: chapters,
    };
  };

  Plugin.prototype.extractContent = function ($) {
    var sels = (CONFIG.chapter.content || []).concat(GENERIC_CONTENT);
    for (var i = 0; i < sels.length; i++) {
      if (!sels[i]) continue;
      var el = $(sels[i]).first();
      if (el.length && el.text().trim().length > 300) return el;
    }
    // readability fallback: densest low-link-ratio block
    var best = null, bs = 0;
    $('div,article,section,main,td').each(function () {
      var el = $(this);
      var t = el.text().trim().length;
      if (t < 400) return;
      var lt = 0;
      el.find('a').each(function () { lt += $(this).text().length; });
      var s = t - 1.3 * lt + el.children('p').length * 25 -
        el.find('div,section,article').length * 8;
      if (s > bs) { bs = s; best = el; }
    });
    return best;
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(this.site + chapterPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var el = this.extractContent($);
    if (!el) return '';
    el.find('script,style,iframe,button,form,ins,.ads,[class*="google"]').remove();
    return el.html() || '';
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (CONFIG.search && CONFIG.search.url) {
      var url = CONFIG.search.url.replace('{query}',
        encodeURIComponent(searchTerm));
      if (url.indexOf('{page}') !== -1) url = url.replace('{page}', page);
      else if (page !== 1) return [];
      var body = await fetchApi(url).then(function (r) { return r.text(); });
      return this.parseItems(cheerio.load(body));
    }
    if (page !== 1) return [];
    var all = await this.popularNovels(1, {});
    var q = searchTerm.toLowerCase();
    return all.filter(function (n) {
      return n.name.toLowerCase().indexOf(q) !== -1;
    });
  };

  Plugin.prototype.resolveUrl = function (path) { return this.site + path; };
  return Plugin;
}());
exports.default = new Plugin();
"""

TPL_WPBLOG = COMMON_HEAD + r"""
// Baked-in project list (re-run `lnrepo add` to refresh)
var NOVELS = __NOVELS__;

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = '__ID__';
    this.name = '__NAME__';
    this.site = '__SITE__';
    this.version = '__VERSION__';
    this.icon = 'icons/__ID__.png';
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
  Plugin.prototype.popularNovels = async function (page) {
    if (page !== 1) return [];
    return NOVELS.map(function (n) {
      return { name: n.name, path: n.path, cover: n.cover || defaultCover };
    });
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
"""

TPL_BLOGSPOT = COMMON_HEAD + r"""
var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = '__ID__';
    this.name = '__NAME__';
    this.site = '__SITE__';
    this.version = '__VERSION__';
    this.icon = 'icons/__ID__.png';
  }
  Plugin.prototype.getPath = function (url) {
    if (!url) return null;
    var host = this.site.replace(/^https?:\/\//, '');
    var u = url.replace(/^https?:\/\//, '');
    if (u.indexOf(host) === 0) {
      return u.substring(host.length).replace(/^\/+/, '');
    }
    return null;
  };
  Plugin.prototype.fetchPages = async function () {
    var d = await fetchApi(this.site +
      'feeds/pages/default?alt=json&max-results=150')
      .then(function (r) { return r.json(); });
    var self = this;
    var entries = (d.feed && d.feed.entry) || [];
    return entries.map(function (e) {
      var alt = (e.link || []).filter(function (l) {
        return l.rel === 'alternate';
      })[0];
      return {
        name: e.title.$t,
        path: alt ? self.getPath(alt.href) : null,
        html: (e.content && e.content.$t) || '',
      };
    }).filter(function (e) { return e.path; });
  };
  Plugin.prototype.popularNovels = async function (page) {
    if (page !== 1) return [];
    var pages = await this.fetchPages();
    var self = this;
    return pages.filter(function (p) {
      var links = (p.html.match(/href="/g) || []).length;
      return links >= 5;
    }).map(function (p) {
      var $ = cheerio.load(p.html);
      return { name: p.name, path: p.path,
        cover: $('img').first().attr('src') || defaultCover };
    });
  };
  Plugin.prototype.parseNovel = async function (novelPath) {
    var pages = await this.fetchPages();
    var pageEntry = pages.filter(function (p) {
      return p.path === novelPath;
    })[0];
    if (!pageEntry) throw new Error('not found: ' + novelPath);
    var $ = cheerio.load(pageEntry.html);
    var self = this, chapters = [];
    $('a[href]').each(function () {
      var path = self.getPath($(this).attr('href'));
      if (!path || !/\d{4}\/\d{2}\//.test(path)) return;
      var name = $(this).text().replace(/\s+/g, ' ').trim();
      if (name) chapters.push({ name: name, path: path });
    });
    return {
      name: pageEntry.name, path: novelPath,
      cover: $('img').first().attr('src') || defaultCover,
      summary: $('p').first().text().trim(),
      chapters: chapters,
    };
  };
  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(this.site + chapterPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var el = $('.post-body').first();
    if (!el.length) el = $('.entry-content').first();
    if (!el.length) return '';
    el.find('script,style,iframe').remove();
    return el.html() || '';
  };
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
"""

TPL_MADARA = COMMON_HEAD + r"""
var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = '__ID__';
    this.name = '__NAME__';
    this.site = '__SITE__';
    this.version = '__VERSION__';
    this.icon = 'icons/__ID__.png';
    this.filters = __FILTERS__;
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
"""

TPL_LNWP = COMMON_HEAD + r"""
var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = '__ID__';
    this.name = '__NAME__';
    this.site = '__SITE__';
    this.version = '__VERSION__';
    this.icon = 'icons/__ID__.png';
    this.filters = __FILTERS__;
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
"""


# ---- SPA: Next.js RSC (embedded JSON) --------------------------------
# Generalized version of the penguin-squad plugin. Works for the common
# Next.js translation-site template where the novel/chapter data is
# streamed as escaped JSON inside self.__next_f.push([1,"..."]) chunks.
TPL_NEXTRSC = COMMON_HEAD + r"""
// Auto-generated for a Next.js (RSC) site. Data is read from the page's
// embedded JSON payload rather than scraped from the DOM (the visible
// chapter list is usually client-side paginated / collapsed).
//
// If chapters come back empty, open a novel page, view-source, and check
// which key holds the chapter array; set CHAPTERS_KEY below to match.
var LISTING_PATH = '__LISTING_PATH__';   // page that lists many novels
var CHAPTERS_KEY = '__CHAPTERS_KEY__';   // JSON key holding the chapter array
var NOVEL_PREFIX = '__NOVEL_PREFIX__';   // url segment before a novel slug

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = '__ID__';
    this.name = '__NAME__';
    this.site = '__SITE__';
    this.version = '__VERSION__';
    this.icon = 'icons/__ID__.png';
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
    var u = url.replace(/^https?:\/\//, '').replace(/#.*$/, '');
    if (u.indexOf(host) === 0) return u.substring(host.length).replace(/(^\/+|\/+$)/g, '');
    return null;
  };
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function imgSrc(img) {
    if (!img || !img.length) return null;
    return img.attr('src') || img.attr('data-src') ||
      (img.attr('srcset') || '').split(' ')[0] || null;
  }

  // Pull an escaped JSON array out of the Next.js RSC payload. Locates
  // the enclosing push([1,"..."]) string literal and lets JSON.parse do
  // the real unescaping, then bracket-matches the array on clean text.
  function extractJsonArray(rawHtml, key) {
    var marker = '\\"' + key + '\\":[';
    var markerPos = rawHtml.indexOf(marker);
    if (markerPos === -1) return null;
    var pushPos = rawHtml.lastIndexOf('push([1,"', markerPos);
    if (pushPos === -1) return null;
    var strStart = pushPos + 'push([1,"'.length;
    var i = strStart, esc = false;
    for (; i < rawHtml.length; i++) {
      var c = rawHtml[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') break;
    }
    var real;
    try { real = JSON.parse('"' + rawHtml.substring(strStart, i) + '"'); }
    catch (e) { return null; }
    var s2 = real.indexOf('"' + key + '":[');
    if (s2 === -1) return null;
    var j = s2 + key.length + 3, depth = 0, inStr = false, e2 = false;
    for (; j < real.length; j++) {
      var d = real[j];
      if (e2) { e2 = false; continue; }
      if (d === '\\') { e2 = true; continue; }
      if (d === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (d === '[') depth++;
      else if (d === ']') { depth--; if (depth === 0) { j++; break; } }
    }
    try { return JSON.parse(real.substring(s2 + key.length + 3, j)); }
    catch (e) { return null; }
  }

  Plugin.prototype.popularNovels = async function (page) {
    if (page !== 1) return [];
    var body = await fetchApi(this.site + LISTING_PATH)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var self = this, novels = [], seen = {};
    $('a[href*="' + NOVEL_PREFIX + '"]').each(function () {
      var a = $(this);
      var path = self.getPath(a.attr('href'));
      if (!path || seen[path] || path.split('/').length > 2) return;
      var name = clean(a.find('h1,h2,h3,h4').first().text()) ||
        a.find('img').attr('alt') || clean(a.attr('title') || a.text());
      if (!name) return;
      seen[path] = 1;
      novels.push({ name: name, path: path,
        cover: self.abs(imgSrc(a.find('img').first())) || defaultCover });
    });
    return novels;
  };

  Plugin.prototype.parseNovel = async function (novelPath) {
    var body = await fetchApi(this.site + novelPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var raw = extractJsonArray(body, CHAPTERS_KEY) || [];
    var chapters = raw.slice().sort(function (a, b) {
      return (a.chapter_number || a.order || 0) - (b.chapter_number || b.order || 0);
    }).map(function (c) {
      var slug = c.slug || c.id;
      return {
        name: (c.premium || c.locked ? '\uD83D\uDD12 ' : '') +
          (c.title || c.name || ('Chapter ' + (c.chapter_number || ''))),
        path: novelPath + '/' + slug,
      };
    });
    return {
      name: clean($('h1').first().text()) || novelPath,
      path: novelPath,
      cover: this.abs(imgSrc($('img[src*="cover"], img[alt]').first())) ||
        $('meta[property="og:image"]').attr('content') || defaultCover,
      summary: clean($('meta[name="description"]').attr('content') ||
        $('[class*="summ"],[class*="desc"],[class*="synop"]').first().text()),
      chapters: chapters,
    };
  };

  Plugin.prototype.parseChapter = async function (chapterPath) {
    var body = await fetchApi(this.site + chapterPath)
      .then(function (r) { return r.text(); });
    var $ = cheerio.load(body);
    var el = $('.reader-content, .chapter-content, article, [class*="prose"]')
      .first();
    if (!el.length) return '';
    el.find('script,style,button,nav,header,footer').remove();
    return el.html() || '';
  };

  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    if (page !== 1) return [];
    var all = await this.popularNovels(1);
    var q = searchTerm.toLowerCase();
    return all.filter(function (n) { return n.name.toLowerCase().indexOf(q) !== -1; });
  };
  Plugin.prototype.resolveUrl = function (path) { return this.site + path; };
  return Plugin;
}());
exports.default = new Plugin();
"""

# ---- SPA: generic API scaffold ---------------------------------------
# For SPAs whose data comes from a JSON API (the boti pattern). This is a
# SCAFFOLD: the auto-detector fills in what it can and marks TODOs for the
# handful of per-site specifics that require one real browser request.
TPL_SPA_API = COMMON_HEAD + r"""
// ============================ SCAFFOLD ============================
// This site is a client-side SPA backed by a JSON API. The generator
// filled in the detected pieces; complete the TODOs using ONE real
// request captured from your browser's DevTools -> Network tab (load a
// novel page, click an XHR/fetch row, copy its URL + request headers).
//
// Detected API candidate(s):
// __API_CANDIDATES__
// =================================================================
var API = '__API_BASE__';          // TODO: confirm base, e.g. https://api.site.com/v1
var EXTRA_HEADERS = __EXTRA_HEADERS__;  // TODO: e.g. { 'site-domain': 'www.site.com' }
var PAGE_SIZE = 30;

// TODO: set the endpoint paths + the JSON fields the API returns.
var EP = {
  list:    '/content/books',            // list of novels     (params: pageNumber,pageSize)
  search:  '/content/books/search',     // search             (params: keyword,pageNumber,pageSize)
  detail:  '/content/books/{id}',       // one novel's detail
  chapters:'/content/chapters/page',    // chapter list       (params: bookId,pageNumber,pageSize)
  content: '/content/chapters/{id}',    // one chapter's html
};
var FIELD = {
  listArray: 'data.list', id: 'id', title: 'title', cover: 'coverImgUrl',
  summary: 'synopsis', chapterArray: 'data.list', chapterId: 'id',
  chapterTitle: 'title', chapterOrder: 'chapterOrder', content: 'data.content',
  totalPages: 'data.totalPages', locked: 'paywallStatus',
};

var Plugin = /** @class */ (function () {
  function Plugin() {
    this.id = '__ID__';
    this.name = '__NAME__';
    this.site = '__SITE__';
    this.version = '__VERSION__';
    this.icon = 'icons/__ID__.png';
  }
  function dig(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return (o == null) ? undefined : o[k];
    }, obj);
  }
  function api(path, params) {
    var url = API + path;
    if (params) {
      var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      if (q) url += (url.indexOf('?') === -1 ? '?' : '&') + q;
    }
    var headers = { 'Accept': 'application/json' };
    for (var k in EXTRA_HEADERS) headers[k] = EXTRA_HEADERS[k];
    return fetchApi(url, { headers: headers }).then(function (r) { return r.json(); });
  }
  function mapBook(b) {
    return { name: dig(b, FIELD.title), path: String(dig(b, FIELD.id)),
      cover: dig(b, FIELD.cover) || defaultCover };
  }

  Plugin.prototype.popularNovels = async function (page) {
    var res = await api(EP.list, { pageNumber: page, pageSize: PAGE_SIZE });
    var list = dig(res, FIELD.listArray) || [];
    return list.map(mapBook);
  };
  Plugin.prototype.searchNovels = async function (searchTerm, page) {
    var res = await api(EP.search, { keyword: searchTerm, pageNumber: page, pageSize: PAGE_SIZE });
    var list = dig(res, FIELD.listArray) || [];
    return list.map(mapBook);
  };
  Plugin.prototype.parseNovel = async function (novelPath) {
    var id = String(novelPath).replace(/[^0-9a-zA-Z_-]/g, '');
    var res = await api(EP.detail.replace('{id}', id));
    var b = (res && res.data) ? res.data : {};
    var chapters = [], pageNumber = 1, totalPages = 1;
    do {
      var cr = await api(EP.chapters, { bookId: id, pageNumber: pageNumber, pageSize: 100 });
      var arr = dig(cr, FIELD.chapterArray) || [];
      totalPages = dig(cr, FIELD.totalPages) || 1;
      arr.forEach(function (c) {
        var locked = c[FIELD.locked] && c[FIELD.locked] !== 'free';
        chapters.push({
          name: (locked ? '\uD83D\uDD12 ' : '') + c[FIELD.chapterTitle],
          path: id + '/' + c[FIELD.chapterId],
          chapterNumber: c[FIELD.chapterOrder],
        });
      });
      pageNumber++;
    } while (pageNumber <= totalPages && pageNumber <= 500);
    chapters.sort(function (a, b2) { return (a.chapterNumber || 0) - (b2.chapterNumber || 0); });
    return {
      name: dig(b, FIELD.title) || novelPath, path: novelPath,
      cover: dig(b, FIELD.cover) || defaultCover,
      summary: (dig(b, FIELD.summary) || '').replace(/\r/g, ''),
      chapters: chapters,
    };
  };
  Plugin.prototype.parseChapter = async function (chapterPath) {
    var id = String(chapterPath).split('/').pop();
    var res = await api(EP.content.replace('{id}', id));
    var content = dig(res, FIELD.content);
    return content || '<p><i>This chapter could not be loaded (may be locked).</i></p>';
  };
  Plugin.prototype.resolveUrl = function (path) { return this.site + path; };
  return Plugin;
}());
exports.default = new Plugin();
"""

FILTERS_DIR = os.path.join(REPO_DIR, "filters")

def load_filters(pid):
    """Browse filters for a plugin, from repo/filters/<id>.json. The file holds
    {"source": <where the values were read from>, "filters": {...}}; a site
    with no filter file has no filters."""
    path = os.path.join(FILTERS_DIR, pid + ".json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)["filters"]

def emit(tpl, meta, extra=None):
    filters = json.dumps(load_filters(meta["id"]), ensure_ascii=False, indent=2)
    out = (tpl.replace("__FILTERS__", filters.replace("\n", "\n    "))
              .replace("__ID__", meta["id"])
              .replace("__NAME__", meta["name"].replace("'", "\\'"))
              .replace("__SITE__", meta["site"])
              .replace("__VERSION__", meta["version"]))
    for k, v in (extra or {}).items():
        out = out.replace(k, v)
    return out

# ------------------------------------------------------------ engine detect

def detect_engine(site, html):
    h = html.lower()
    if "wp-manga" in h or 'madara' in h:
        return "madara"
    if any(k in h for k in ("eplister", "ts-breadcrumb", "themesia",
                            "lightnovel-wp", "ts-post-image", "sertobig",
                            "sertothumb")):
        return "lightnovelwp"
    if "blogspot." in urlparse(site).netloc or "blogger.com" in h:
        return "blogspot"
    if "wp-content" in h or "wordpress" in h:
        rest = http_json(site + "wp-json/wp/v2/pages?per_page=1")
        if isinstance(rest, list):
            return "wpblog"
    kind, _ = analyze_spa(site, html)
    if kind == "nextjs-rsc":
        return "nextjs"
    if kind == "spa-api":
        return "spa"
    return "universal"


# ------------------------------------------------------------ SPA analysis

def analyze_spa(site, html):
    """Detect client-side-rendered sites and gather what a plugin needs.

    Returns (kind, info) where kind is one of:
      'nextjs-rsc' - Next.js; data streamed as embedded JSON (auto-handled)
      'spa-api'    - generic SPA; a same/other-origin JSON API was probed
      None         - not an obvious SPA
    Detection is best-effort: the generic case emits a documented scaffold
    that a human completes with one real request from the browser Network
    tab (the per-site JSON key / API host / headers can't be fully guessed).
    """
    h = html.lower()
    info = {"host": urlparse(site).netloc}

    # Next.js RSC: data is in self.__next_f.push([...]) chunks in the HTML.
    if "__next_f" in html or "/_next/static" in html:
        info["kind"] = "nextjs-rsc"
        # sniff which JSON keys look like the chapter/novel arrays
        keys = set(re.findall(r'\\"(\w+)\\":\[', html))
        info["keys"] = sorted(k for k in keys
                              if k in ("chapters", "novels", "books",
                                       "series", "episodes", "list"))
        return "nextjs-rsc", info

    # Generic SPA shell. The reliable tell is an *empty content mount*
    # (<div id="widgets|app|root"></div> that JS later fills), plus module
    # bundles. Footer/nav text inflates total body length, so we look for
    # an empty container directly rather than trusting a length threshold.
    bundles = re.findall(r'<script[^>]+src="([^"]+\.js)"', html)
    empty_mount = re.search(
        r'<(?:div|main)[^>]+(?:id|class)="[^"]*'
        r'(widgets|app|root|__next|nuxt|content)[^"]*"[^>]*>\s*</(?:div|main)>',
        html, re.I)
    marker = any(k in h for k in ('id="app"', 'id="root"', 'data-reactroot',
                                  'ng-app', '__nuxt', 'window.__nuxt__'))
    if not ((empty_mount and bundles) or (marker and bundles)):
        return None, info

    info["kind"] = "spa-api"
    # include modulepreload chunks - API host/base often lives in those
    preloads = re.findall(r'<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"', html)
    chunks = [urljoin(site, b) for b in (bundles + preloads)][:10]
    info["bundles"] = chunks
    hdrs = {"User-Agent": UA, "Referer": site, "Accept": "*/*",
            "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin", "Origin": site.rstrip("/")}
    api_hosts = set()
    for b in chunks:
        try:
            req = urllib.request.Request(b, headers=hdrs)
            with urllib.request.urlopen(req, timeout=20) as r:
                js = r.read().decode("utf-8", "replace")
        except Exception:
            continue
        # absolute hosts with api/backend, and base-url string assignments
        for m in re.findall(r'"(https?://[a-z0-9.-]*(?:api|backend)[a-z0-9.-]*[^"]*)"', js):
            api_hosts.add(m)
        for m in re.findall(r'=\s*"(https?://[a-z0-9.-]+/[a-z0-9/_-]*(?:backend|api|v1|v2)[a-z0-9/_-]*)"', js):
            api_hosts.add(m)
    # rank: prefer ones that look like a real base (have a path)
    ranked = sorted(api_hosts, key=lambda u: (u.count("/") < 4, len(u)))
    info["apiCandidates"] = ranked[:8]
    return "spa-api", info


# ------------------------------------------------------------ state / cmds

def load_state():
    if os.path.exists(STATE_FILE):
        return json.load(open(STATE_FILE))
    return {"plugins": []}

def save_state(s):
    os.makedirs(REPO_DIR, exist_ok=True)
    json.dump(s, open(STATE_FILE, "w"), indent=2)

def cmd_add(args):
    site = args.url if args.url.endswith("/") else args.url + "/"
    os.makedirs(PLUGINS_DIR, exist_ok=True)
    os.makedirs(ICONS_DIR, exist_ok=True)
    print(f"[*] Fetching {site} ...")
    html = try_get(site)
    if html is None and not args.config:
        sys.exit("!! Site unreachable (Cloudflare/anti-bot?). Two options:\n"
                 "   1) write selectors by hand and pass --config file.json\n"
                 "   2) run this tool from an IP the site accepts")
    engine = args.engine
    if engine == "auto":
        engine = detect_engine(site, html or "")
    print(f"[*] Engine: {engine}")

    m = re.search(r"<title>(.*?)</title>", html or "", re.S | re.I)
    default_name = re.split(r"[|\u2013\u2014-]", m.group(1))[0].strip() \
        if m else urlparse(site).netloc
    name = args.name or default_name
    pid = args.id or slugify(name)
    meta = {"id": pid, "name": name, "site": site, "version": "1.0.0",
            "lang": args.lang, "engine": engine}
    print(f"[*] id={pid}  name=\"{name}\"")

    print("[*] Grabbing icon ...")
    ok = grab_icon(site, html or "", os.path.join(ICONS_DIR, f"{pid}.png"))
    print("    " + ("icon saved" if ok else "placeholder icon"))

    code = None
    if engine == "wpblog":
        print("[*] Discovering novels (WP REST) ...")
        novels = discover_wpblog_novels(site, html)
        if novels:
            code = emit(TPL_WPBLOG, meta,
                        {"__NOVELS__": json.dumps(novels, indent=2)})
        else:
            print("    ! none found -> falling back to universal")
            engine = meta["engine"] = "universal"
    elif engine == "madara":
        code = emit(TPL_MADARA, meta)
    elif engine == "lightnovelwp":
        code = emit(TPL_LNWP, meta)
    elif engine == "blogspot":
        code = emit(TPL_BLOGSPOT, meta)
    elif engine == "nextjs":
        print("[*] Next.js RSC site: reading embedded JSON payload ...")
        # find the novel-url prefix from homepage links
        p = LinkParser(); p.feed(html)
        segs = {}
        first_novel = {}
        for href, _ in p.links:
            path = urlparse(urljoin(site, href)).path
            m = re.match(r"/([a-z-]+)/[^/]+/?$", path)
            if m:
                seg = m.group(1)
                segs[seg] = segs.get(seg, 0) + 1
                first_novel.setdefault(seg, urljoin(site, href))
        prefix = max(segs, key=segs.get) if segs else "novels"
        listing = prefix if try_get(site + prefix) else ""
        # sniff the chapters key from a REAL novel page (not the homepage)
        ch_key = "chapters"
        sample = first_novel.get(prefix)
        if sample:
            nhtml = try_get(sample) or ""
            nkeys = set(re.findall(r'\\"(\w+)\\":\[', nhtml))
            for cand in ("chapters", "episodes", "chapterList", "list"):
                if cand in nkeys:
                    ch_key = cand; break
        print(f"    chapters key: {ch_key} | novel prefix: /{prefix}/")
        code = emit(TPL_NEXTRSC, meta, {
            "__LISTING_PATH__": listing,
            "__CHAPTERS_KEY__": ch_key,
            "__NOVEL_PREFIX__": "/" + prefix + "/",
        })
    elif engine == "spa":
        print("[*] Generic SPA: probing bundles for a JSON API ...")
        kind, info = analyze_spa(site, html)
        cands = info.get("apiCandidates", [])
        for c in cands:
            print(f"    api candidate: {c}")
        api_base = cands[0] if cands else "https://api.CHANGME.com/v1"
        code = emit(TPL_SPA_API, meta, {
            "__API_BASE__": api_base,
            "__API_CANDIDATES__": ("\n// ".join(cands) if cands
                                   else "(none auto-found; check Network tab)"),
            "__EXTRA_HEADERS__": "{ 'Referer': '" + site + "' }",
        })
        print("    ! SCAFFOLD written - complete the TODOs with one browser request")

    if engine == "universal":
        if args.config:
            cfg = json.load(open(args.config))
            print("[*] Using manual config " + args.config)
        else:
            print("[*] Universal analysis (this fetches several pages) ...")
            cfg, report = Analyzer(site).run()
            for k, v in report.items():
                print(f"    {k:<8} {v}")
        for key in ("listing", "novel", "chapter", "search"):
            cfg.setdefault(key, {})
        code = emit(TPL_UNIVERSAL, meta,
                    {"__CONFIG__": json.dumps(cfg, indent=2)})

    out = os.path.join(PLUGINS_DIR, f"{pid}.js")
    open(out, "w").write(code)
    print(f"[+] Wrote {os.path.relpath(out, ROOT)}")
    state = load_state()
    state["plugins"] = [p for p in state["plugins"] if p["id"] != pid] + [meta]
    save_state(state)

def cmd_probe(args):
    site = args.url if args.url.endswith("/") else args.url + "/"
    html = try_get(site)
    print("engine:", detect_engine(site, html or ""))
    cfg, report = Analyzer(site).run()
    print(json.dumps(cfg, indent=2))
    for k, v in report.items():
        print(f"{k:<8} {v}")

def _lang_dir(lang):
    return (lang or "english").strip().lower().replace(" ", "-")

def cmd_build(args):
    """Emit an LNReader/Mihon-style extension-repo layout:

        <subdir>/
          .dist/plugins.min.json     <- manifest you add to LNReader
          .dist/plugins.json         <- pretty-printed, for humans/diffs
          icons/<id>.png
          src/plugins/<lang>/<id>.js
    """
    state = load_state()
    if not state["plugins"]:
        sys.exit("No plugins added yet.")
    sub = args.subdir.strip("/") + "/" if args.subdir else ""
    raw_host = args.base_url.rstrip("/") if args.base_url else "https://raw.githubusercontent.com"
    if args.token:
        # Embed the PAT as basic-auth userinfo. This is the only plain-URL form
        # GitHub honours for PRIVATE raw content — the ?token= query form is
        # rejected (404). Baking the token into the manifest is a secret in the
        # repo, so pair this with a private repo + a read-only fine-grained PAT.
        for scheme in ("https://", "http://"):
            if raw_host.startswith(scheme):
                raw_host = scheme + args.token + "@" + raw_host[len(scheme):]
                break
    base = f"{raw_host}/{args.github}/{args.branch}/{sub}".rstrip("/")

    dist = os.path.join(REPO_DIR, ".dist")
    icons_out = os.path.join(REPO_DIR, "icons")
    os.makedirs(dist, exist_ok=True)
    os.makedirs(icons_out, exist_ok=True)

    index = []
    for p in state["plugins"]:
        lang = _lang_dir(p["lang"])
        src_rel = f"src/plugins/{lang}/{p['id']}.js"
        src_abs = os.path.join(REPO_DIR, src_rel)
        os.makedirs(os.path.dirname(src_abs), exist_ok=True)
        # move plugin JS from the flat legacy location into src/plugins/<lang>/
        legacy = os.path.join(PLUGINS_DIR, f"{p['id']}.js")
        if os.path.exists(legacy) and os.path.abspath(legacy) != os.path.abspath(src_abs):
            with open(legacy) as f: body = f.read()
            with open(src_abs, "w") as f: f.write(body)
        # keep the version and name baked into the JS in lockstep with the
        # manifest — LNReader compares the two and shows a perpetual "update"
        # badge when they differ, so edits in sources.json must reach the
        # plugin file too
        if os.path.exists(src_abs):
            with open(src_abs) as f: body = f.read()
            synced = re.sub(r"(this\.version\s*=\s*')[^']*(')",
                            lambda m: m.group(1) + p["version"] + m.group(2),
                            body, count=1)
            synced = re.sub(r"(this\.name\s*=\s*')(?:[^'\\]|\\.)*(')",
                            lambda m: m.group(1) + p["name"].replace("'", "\\'") + m.group(2),
                            synced, count=1)
            if synced != body:
                with open(src_abs, "w") as f: f.write(synced)
        entry = {"id": p["id"], "name": p["name"], "site": p["site"],
                 "lang": p["lang"], "version": p["version"],
                 "url": f"{base}/{src_rel}"}
        if not args.no_icons:
            entry["iconUrl"] = f"{base}/icons/{p['id']}.png"
        index.append(entry)

    json.dump(index, open(os.path.join(dist, "plugins.min.json"), "w"),
              separators=(",", ":"), ensure_ascii=False)
    json.dump(index, open(os.path.join(dist, "plugins.json"), "w"),
              indent=2, ensure_ascii=False)

    # clean up the legacy flat plugins/ dir once migrated
    if os.path.isdir(PLUGINS_DIR):
        for f in os.listdir(PLUGINS_DIR):
            os.remove(os.path.join(PLUGINS_DIR, f))
        try: os.rmdir(PLUGINS_DIR)
        except OSError: pass

    print(f"[+] Built .dist/plugins.min.json with {len(index)} plugin(s)")
    print(f"    layout: .dist/  icons/  src/plugins/<lang>/")
    print(f"\nPush {sub or './'} to GitHub `{args.github}` then add in LNReader:")
    print(f"  {base}/.dist/plugins.min.json")

def scrape_lnwp_filters(site):
    """Read the browse filters a LightNovelWP site offers on /series/: genre[],
    type[] (checkboxes), status and order (single choice)."""
    html = http_get(site + "series/")
    form = {}
    for tag in re.findall(r"<input\b[^>]*>", html):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', tag))
        name, value, iid = attrs.get("name"), attrs.get("value", ""), attrs.get("id")
        if not iid:
            continue
        if name not in ("genre[]", "type[]", "status", "order"):
            continue
        lab = re.search(r'<label[^>]*for="%s"[^>]*>(.*?)</label>' % re.escape(iid), html, re.S)
        label = re.sub(r"<[^>]+>|\s+", " ", lab.group(1)).strip() if lab else (value or "All")
        opts = form.setdefault(name, [])
        if all(o["value"] != value for o in opts):
            opts.append({"label": label or "All", "value": value})
    if "genre[]" not in form:
        sys.exit(f"{site}series/ has no genre[] inputs -- not a LightNovelWP filter form")
    filters = {}
    for key, label in (("genre[]", "Genres"), ("type[]", "Type")):
        if form.get(key):
            filters[key] = {"type": "Checkbox", "label": label, "value": [], "options": form[key]}
    if form.get("status"):
        filters["status"] = {"type": "Picker", "label": "Status", "value": "", "options": form["status"]}
    if form.get("order"):
        default = "popular" if any(o["value"] == "popular" for o in form["order"]) else form["order"][0]["value"]
        filters["order"] = {"type": "Picker", "label": "Order by", "value": default, "options": form["order"]}
    return filters

def cmd_filters(args):
    """Write repo/filters/<id>.json from the site's own filter form."""
    p = next((x for x in load_state()["plugins"] if x["id"] == args.id), None)
    if p is None:
        sys.exit(f"no plugin {args.id!r} in sources.json")
    if p["engine"] != "lightnovelwp":
        sys.exit(f"{args.id}: filter scraping is implemented for lightnovelwp sites only "
                 "(madara filters come from tools/official_filters.js)")
    filters = scrape_lnwp_filters(p["site"])
    os.makedirs(FILTERS_DIR, exist_ok=True)
    with open(os.path.join(FILTERS_DIR, args.id + ".json"), "w", encoding="utf-8") as f:
        json.dump({"source": p["site"] + "series/ filter form", "filters": filters}, f,
                  indent=2, ensure_ascii=False)
    print(f"[+] {args.id}: " + ", ".join(f"{k} ({len(v.get('options', []))})" for k, v in filters.items()))

def cmd_regen(args):
    """Re-emit a template plugin from its template and filter file."""
    tpls = {"madara": TPL_MADARA, "lightnovelwp": TPL_LNWP, "wpblog": TPL_WPBLOG}
    p = next((x for x in load_state()["plugins"] if x["id"] == args.id), None)
    if p is None:
        sys.exit(f"no plugin {args.id!r} in sources.json")
    if p["engine"] not in tpls:
        sys.exit(f"{args.id}: engine {p['engine']!r} is hand-written, not regenerable")
    dest = os.path.join(REPO_DIR, "src", "plugins", _lang_dir(p["lang"]), p["id"] + ".js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write(emit(tpls[p["engine"]], p))
    print(f"[+] regenerated {os.path.relpath(dest, ROOT)} from the {p['engine']} template")

def cmd_list(_):
    for p in load_state()["plugins"]:
        print(f"{p['id']:<22} {p['engine']:<13} {p['site']}")

def main():
    ap = argparse.ArgumentParser(prog="lnrepo")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("url")
    a.add_argument("--name"); a.add_argument("--id")
    a.add_argument("--lang", default="English")
    a.add_argument("--engine", default="auto",
        choices=["auto","madara","lightnovelwp","wpblog","blogspot",
                 "nextjs","spa","universal"])
    a.add_argument("--config", help="manual universal-config JSON")
    a.set_defaults(fn=cmd_add)
    p = sub.add_parser("probe"); p.add_argument("url"); p.set_defaults(fn=cmd_probe)
    b = sub.add_parser("build"); b.add_argument("--github", required=True)
    b.add_argument("--branch", default="main")
    b.add_argument("--token", help="GitHub PAT embedded (basic-auth) in every "
        "manifest URL so a PRIVATE repo works in LNReader. Bakes the token into "
        "plugins.min.json — use only with a private repo + a read-only "
        "fine-grained PAT; don't make the repo public with this in place.")
    b.add_argument("--base-url", help="replace https://raw.githubusercontent.com "
        "with a proxy/Worker base that injects auth server-side (keeps the token "
        "OUT of the manifest). Must forward /<owner>/<repo>/<branch>/<path>.")
    b.add_argument("--subdir", default="",
        help="path inside the repo where plugins.min.json/plugins/icons live "
             "(e.g. 'repo' if you pushed the whole project folder as-is)")
    b.add_argument("--no-icons", action="store_true",
                   help="omit iconUrl so a private repo's icons aren't fetched")
    b.set_defaults(fn=cmd_build)
    l = sub.add_parser("list"); l.set_defaults(fn=cmd_list)
    fl = sub.add_parser("filters"); fl.add_argument("id"); fl.set_defaults(fn=cmd_filters)
    rg = sub.add_parser("regen"); rg.add_argument("id"); rg.set_defaults(fn=cmd_regen)
    args = ap.parse_args(); args.fn(args)

if __name__ == "__main__":
    main()
