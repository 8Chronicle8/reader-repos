# Development notes

How each supported site delivers its data, and what to remember when adding or
maintaining plugins. What changed and when is in CHANGES.md.

## What this is
`lnrepo.py` generates LNReader v3 plugins for novel sites and builds the
repository manifest (`repo/.dist/plugins.min.json`). Plugins are plain
JavaScript run by the app, so each file is self-contained; code shared between
them is either emitted by the generator (`COMMON_HEAD`, the engine templates)
or synced by `tools/private_common.py`.

## Plugins (13, all checked live on 2026-11-13)
Template plugins, re-emitted with `lnrepo.py regen <id>`:
noicetranslations, wuxiaworldsite (`madara`); dobytranslations,
primodialtranslation (`lightnovelwp`). Edit the template, not the output.

Hand-written: thesuniscold (`wpblog`, since adapted), taptotale (`universal`),
penguinsquad, novellunar, noveldex, botitranslation, brightnovels,
genesistudio, fenrirealm.

## Shared behaviour
- **Retry:** every plugin wraps `fetchApi` with up to three attempts on network
  errors and 5xx (`COMMON_HEAD`).
- **Hide locked chapters:** `tools/private_common.js` is appended to every plugin
  whose source marks chapters with 🔒. It adds the setting and filters
  `parseNovel` output, reading the setting on each call. `private_common.py
  check` (part of `check.sh`) fails if a copy drifts, is missing where a plugin
  marks locks, or is present where it does not.
- **Filters** come from data with a stated source: `repo/filters/<id>.json` for
  template plugins (`source` names where each list was read), and inline,
  with the same note, in hand-written plugins. Madara lists are read from the
  official plugin with `tools/official_filters.js`; LightNovelWP lists from the
  site's own `/series/` form with `lnrepo.py filters <id>`.
- **A failure says why.** A Cloudflare page, a captcha requirement or an HTTP
  error is raised with a message for the user, never returned as an empty list.

## Site notes

### fenrirealm.com
SvelteKit over a JSON API (`api/new/v2/`). Browse filters that work:
`sort=popular|latest|updated`, `statuses[]=<status>`, `genres[]=<numeric id>`
(genre slugs are silently ignored; checked against the result totals).
Chapters: `series/<slug>/chapters/<chapterSlug>` returns the chapter's `uuid`
and, with a valid read token, the text AES-256-GCM encrypted and split into
shuffled fragments (schemes `fragmented-v1`/`-v2`; key and order derived from
the token, as the site's reader does). Read tokens:
- the first one needs a captcha, which a person passes in WebView; the plugin
  never attempts it and says so when it is needed;
- a valid token (or the WebView session's `fr_read` cookie) can be exchanged at
  `POST /api/read-token` for a fresh one a limited number of times
  (`x-read-token-exchanges-remaining`); responses may also rotate the token
  (`x-read-token-issued`);
- the plugin stores the current token in plugin storage, captures rotated ones,
  and exchanges a token in its last minute, so a session survives app restarts
  until the exchange allowance runs out.
`test/fenrir_crypto_test.js` proves the flow against a fake server and checks
decryption against the official plugin's own `decryptWithToken`. Not proven
here: the live site's behaviour after a real WebView check (that needs a
person); verify on a device.

Library paths stay `series/<slug>` and `series/<slug>/<chapterSlug>`; the
official plugin's shapes (`<slug>`, `…~~<uuid>`) are accepted too.

### genesistudio.com
Next.js RSC + Directus (proxied at `/api/directus/...`) + Supabase storage. The
proxy ignores filter params, so the genre filter and the sorts (newest,
recently updated, top rated, most rated) run over the full catalogue (about 300
entries, one request). Novel pages embed `initialChapters` with
`isPaid/isUnlocked`; paid chapters are marked 🔒 and return a locked notice.
Chapter text: `GET /api/chapters/<id>/content`; chapter paths carry `::<id>`.

### noveldex.io
JSON API: `/api/series?sort=&page=` takes the same filter params as the site's
browse page (`genre`, `exgenre`, `tag`, `extag`, `type`, `status`, `origin`,
`sale`, `images`, `ch_min`, `ch_max`; checked against result totals). Full
chapter list from `chapter/1`'s RSC (`allChapters`). Chapter bodies arrive
encoded and are decoded in-plugin. HTML routes return 403 to Node's fetch (TLS
fingerprint) but 200 to curl and the app; the harness only uses the API.

### Madara sites (noicetranslations, wuxiaworldsite)
Post-type slug varies (`novel|manga|series|...`): the template probes and
caches it. Filtered browsing uses the search form
(`/page/N/?s=&post_type=wp-manga&genre[]=...`). Paid chapters carry
`premium-block` on their `<li>`. Chapter lists load by AJAX (`<novel>/ajax/chapters/`
or `admin-ajax.php action=manga_get_chapters`).

### LightNovelWP sites (dobytranslations, primodialtranslation)
Filters on `/series/?genre[]=&type[]=&status=&order=`. Their public chapter
lists contain only readable chapters (checked: the newest listed chapters
return full text), so no chapter is marked locked. Ad scripts inside chapter
bodies are stripped.

### brightnovels.com
Laravel + Inertia.js: page props are JSON in `<div id="app" data-page="...">`.
Its Cloudflare has at times refused the app's TLS fingerprint with no
challenge; the plugin can route through a user-run proxy (setting "Proxy URL",
`tools/cf-worker.js`). Direct access worked on 2026-11-13.

### novellunar.com
Next.js App Router; content lives in the `self.__next_f.push` RSC stream
(Flight text chunks `<id>:T<hexLen>,` are UTF-8 byte lengths). Since
2026-11 the site is behind Cloudflare: curl, Node and headless Chromium all get
the challenge or block page, so it cannot be checked from a script. The
plugin reports the challenge and asks for WebView; LNReader then sends the
clearance cookie with plugin requests.

## Removed sites
- **curspe.com** (2026-11-13): the server refuses connections from every
  network tried (no route / connection refused).
- **zetrotranslation.com** (2026-11-13): retired by its owners; the site points
  to konkon.ink, which the official repository covers (its plugin passes).
- Earlier: royalroad, novelfull, hangukhub (see git history).
- Not built: wuxiaworld.com (commercial, paywalled, terms forbid
  republication); cyborg-tl.com and asianovel.net (Cloudflare managed challenge).

## Testing
- `test/harness.js` runs a plugin against its live site with the same library
  shims and filter values the app provides; `--hide-locked` and `--filters`
  exercise the settings. A run that ends in a WebView message means the site
  needs a person's check, not that the plugin is broken.
- `./check.sh` runs every offline check; `--live` adds every plugin;
  `--release` counts a skipped check as a failure.

## Conventions
- `getPath()` is protocol-agnostic.
- Chapter lists are de-duplicated and numerically ordered.
- A plugin must not list chapters it cannot open; verify `parseChapter` returns
  real text (>400 chars) before considering a site done.
- Never change a plugin's library path format: saved novels and reading
  progress are keyed by it.
