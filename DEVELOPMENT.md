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
Chapters: `series/<slug>/chapters/<chapterSlug>` (with
`X-Accepts-Encrypted-Content: 3`) returns the chapter's `uuid`, and with a
reading session the text AES-256-GCM encrypted, split into shuffled fragments
(`fragmented-v1`/`-v2`), for a token bound to that one chapter (`cid` in the
token payload). How the site's own reader works (read from its JS, 2026-11-13):
- the reading session is a cookie the site sets when a person passes its check
  (Turnstile or Cap); the page never sends a Cookie header itself;
- `POST /api/read-token {chapter_id}` exchanges the session for a token for
  that chapter, first without a captcha token; `exchanges_remaining` counts
  down; when it refuses with `challenge_required` the person must check again;
- a chapter response may carry the chapter's token in `x-read-token-issued`;
  if the body cannot be decrypted, the reader mints for that chapter and
  refetches;
- the reader renews the session shortly before its token expires.
The plugin does the same and never sets a Cookie header: LNReader shares the
WebView's cookies with plugin requests, and an explicit header would replace
the session the WebView created (the 1.1.0 plugin did exactly that, which is
why it failed even after a WebView check). It never attempts the check.
`test/fenrir_crypto_test.js` holds the flow to a fake server built from that
reader code (session cookie the plugin cannot see; tokens per chapter; three
ways of handing out the token) and checks decryption against the official
plugin's `decryptWithToken`. Not provable from here: the live site after a
real check. Errors end with a `[...]` diagnostic line for that case:
each request's status, the mint result, and whether the server saw the
reading cookie (`hasReadCookie` in the server-rendered chapter page). The
check is Cap (proof of work, served from fenrirealm.com/cap/); the plugin does
not solve it.

Device result (2026-11-13, LNReader 2.1.4, Android 17): after passing the check
in WebView, the plugin's requests carried the session cookie (the server's
`hasReadCookie` was true) and the site still answered the chapter as locked and
refused the token exchange. The site sets a visitor cookie `fr_vid` and binds
reading to IP + visitor; its check also rejects automated browsers ("Blocked by
instrumentation: automated_browser_detected"). That first reading ("only the browser that
passed the check is served") was too strong: the official plugin reads some of
the time. One difference was found: a chapter has three addresses, the one
this plugin used (`series/<s>/chapters/<c>`), the site reader's
(`series/<s>/[<volume>/]<number>[.<part>]`) and the official plugin's
(`chapters/<uuid>`); without a session they answer alike, so which honours a
session cannot be seen from outside. 1.1.4 tries them in that order and logs
each. 1.1.5 asks for the token before any chapter request, as the official
plugin does; chapter ids come from the list stored when the novel is opened.

Device result for 1.1.5 (2026-11-14): `token request HTTP 403 challenge` as the
very first request, `session cookie seen`, every address locked; the official
plugin failed the same way at the same time (its owner reports it gets through
about once a day). So request order was not the cause. What is left between
the WebView and the app is the client itself, which the site's bot detection
judges; passing it by disguising the app is not done here. Status: reading in
the app is unavailable; everything else in the plugin works. Passing the site's bot detection by disguising the app as a browser is
not done.

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

### botitranslation.com
StoryWave backend (`api.mystorywave.com`, header `site-domain`). Browse uses
the site's own ranking lists, `POST /content/books/custom/<List>` with
`{conditionJson: "{}", pageNumber, pageSize}` (lists `MostPopularLocal`,
`TranslationMostPopularLocal`, `MostWordCountLocal`, `LastUpdatedLocal`, as
the home page sends them): this site's catalogue (1,971 books), paged on the
server. `GET /content/books` is the whole StoryWave network (about 20,000) and
is no longer used for browsing. The lists ignore genre and status, so with
either filter set the plugin fetches the whole list of the chosen order once
(about 5 MB, kept 10 minutes) and filters it; status 1 = ongoing, 2 = completed.
The website itself is behind a Cloudflare challenge; the API is not.

### brightnovels.com
Laravel + Inertia.js: page props are JSON in `<div id="app" data-page="...">`.
`/series` accepts `sort=trending|updated|title` (+ `order=asc`; nothing =
newest), `status=ongoing|completed|hiatus`, `genres=<slug,...>` and
`tags=<slug,...>` (comma = any of); `origin` in any form is ignored. Tag slugs
drop `/` and apostrophes (`College/University` -> `collegeuniversity`); the
plugin's conversion matches all 758 site tags.
Its Cloudflare has at times refused the app's TLS fingerprint with no
challenge; the plugin can route through a user-run proxy (setting "Proxy URL",
`tools/cf-worker.js`). Direct access worked on 2026-11-13.

### penguin-squad.com
`/novels` returns the whole catalogue (234) and accepts `genre=<name>`,
`tag=<name>` (one each), `status=ongoing|completed|dropped`,
`illustrated=true`, `sort=views|newest` (default updated). Language values
are not exposed and no guess had an effect, so there is no language filter.

### taptotale.com
Each novel is a WordPress category (127, flat, no tags); sorting uses the REST
API's `orderby=count|name|id`.

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
