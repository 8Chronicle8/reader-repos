# Changes

## 2026-11-13 (late) — Fenrir 1.1.4: the site reader's address, a correction

1.1.3 concluded the site serves chapters only to the browser that passed its
check. The owner reports the official plugin reads some of the time, so that
was wrong as stated, and the README no longer says it. A difference was found
instead: this plugin asked for chapters at an address neither the site's reader
nor the official plugin uses. 1.1.4 resolves the chapter at the old address,
then reads it at the site reader's address (`series/<s>/<number>`), renews the
token, and retries the reader's address, the official plugin's
(`chapters/<uuid>`) and the old one, each step in the diagnostic. The offline
test serves the session at only one of the three addresses at a time and the
plugin reads the chapter in each case; 1.1.3 fails it.

## 2026-11-13 (night) — Fenrir 1.1.3: the site refuses in-app reading

The 1.1.2 device report was `[chapter 200 locked, mint 403 challenge, cookie
seen]`: the WebView session reached the site and was refused anyway. The site
ties reading to the browser that passed its check (visitor cookie `fr_vid`,
IP, and a check that rejects automated clients). The plugin cannot read
chapters in the app without disguising the app as a browser, which it will not
do. 1.1.3 says so and points to WebView reading when the cookie arrives but is
refused, keeps asking for the check when it does not arrive, and spells out the
diagnostic (`chapter request HTTP 200 locked; ...`) so the status code is not
mistaken for a chapter number.

## 2026-11-13 (evening) — Fenrir 1.1.2: same-origin requests, cookie diagnostic

A device test of 1.1.1 reported `[chapter 200 locked, mint challenge]`: after
a WebView check the site still saw no reading session. 1.1.2:
- sends every request with `credentials: 'include'`, so the app's HTTP client
  attaches the WebView cookie jar explicitly rather than by default;
- sends `Origin`, `Referer` and `Sec-Fetch-Site: same-origin` like the site's
  own reader (a cookie-backed POST without them is commonly refused);
- on failure, fetches the chapter page, whose server-rendered data says
  `hasReadCookie`, and reports `cookie seen` / `cookie not seen`, so the next
  report tells a missing cookie from a refused one.
The offline test now requires both; 1.1.1 fails it with the reported line.

## 2026-11-13 (latest) — sort and filters for the remaining plugins (1.1.1)

Each option was taken from what the site itself accepts and checked live:
- **Penguin Squad:** sort (updated, views, newest), genre, tag, status,
  illustrated; result counts equal the site's own (Action 74, Academy 40,
  completed 42, illustrated 89, Action+completed 10).
- **Bright Novels:** sort (trending, newest, updated, title A-Z/Z-A), status,
  genres (any of), tags typed by name (758 tags; names converted to the site's
  slugs, matching all 758). Origin is not offered: the site ignores it.
- **TapToTale:** sort (most chapters, title, newest added); the site has no
  genres or tags.
- **The Sun Is Cold:** sort by title; four novels and no genre or status data.
- **Novellunar:** sort (ranking, latest), its two listing pages. Not checkable
  live from here (Cloudflare); genre or status filters could not be found.

## 2026-11-13 (later) — Fenrir session, Boti filters, Anikku URL

- **Fenrir Realm 1.1.1:** 1.1.0 failed even after a WebView check: it sent its
  own `Cookie: fr_read=<token>` header, replacing the session cookie the
  WebView had created, and its first exchange left out `chapter_id`. Rewritten
  to follow the site's own reader code: no Cookie header (the app's cookie jar
  carries the session), mint per chapter, decrypt with that chapter's token,
  mint and refetch when a body cannot be decrypted, renew before expiry.
  Errors now end with a diagnostic line. The offline test was rebuilt on the
  site's real model; it fails on 1.1.0 with the reported symptom and passes on
  1.1.1. Live reading is still unproven from here (needs a person's check).
- **Boti Translation 1.1.1:** sort (most popular, popular translations, most
  words, recently updated) from the site's own ranking lists, plus genre and
  status filters. Browse now lists this site's catalogue; before, it listed the
  whole StoryWave network. Each sort and filter checked live against the API's
  own genre and status for every result.
- **Anikku URL:** Anikku only accepts a repository URL ending in
  `/index.min.json` (`CreateExtensionRepo`, `^https://.*/index\.min\.json$`).
  The docs said to enter the base URL, which Anikku rejects; corrected for the
  patched repo and `mirror-anikku`.

## 2026-11-13 — rebase on the latest official repositories

### LNReader plugins (all now 1.1.0)
- **Fenrir Realm:** the site now encrypts chapter text and requires a read
  token, which broke the plugin (it returned a 33-character page). Rewritten:
  decryption ported from the official plugin; the read token is stored in
  plugin storage, rotated tokens are captured, and a token is exchanged before
  it expires, so one WebView check lasts across restarts until the site's
  exchange allowance runs out (the official plugin keeps the token in memory
  only, which is why it works only some of the time). Genre filter fixed: the
  API ignores genre slugs, so it now sends the numeric ids. Library paths are
  unchanged. Proven offline by `test/fenrir_crypto_test.js` (fake server +
  parity with the official decryption); live reading needs a person's captcha,
  so it is not proven here.
- **Hide locked chapters** for every plugin that lists paid chapters (8), from
  one shared block (`tools/private_common.js`), checked for drift by `check.sh`.
- **Filters** added: NovelDex (the official set; its API accepts the same
  params), Genesis (genre + four sorts; the official plugin declares filters it
  never applies), Noice and WuxiaWorld.site (official Madara lists), Doby and
  Primodial (read from each site's form). Each filter was checked live to
  change the result set.
- Madara and LightNovelWP plugins are regenerated from the templates again
  (they had drifted); the templates gained filters, `premium-block` lock
  marking, de-duplicated listings, and ad-script removal.
- **Novellunar:** behind Cloudflare since 2026-11; it now says so and asks for
  WebView instead of returning an empty list.
- **Bright Novels:** the proxy is now an optional plugin setting instead of a
  hard-coded Worker URL; `tools/cf-worker.js` is a proxy-only recipe with a
  host allow-list.
- **Removed:** Curspe (server unreachable from every network tried) and Zetro
  Translation (retired by its owners; its new home konkon.ink is covered by the
  official repository).
- `test/harness.js` now mirrors the app's runtime (real `FilterTypes` values,
  default filter values, `@libs/storage`, `@libs/aes`, dayjs, htmlparser2),
  validates filter schemas, and checks "Hide locked chapters" both ways.

### Anikku
- Rebuilt on `yuzono/anime-extensions@227457f` with its new Gradle build:
  `patches/apply_private_build.py` replaces the old suffix script (absolute
  class meta-data and keep rule, `-P` names, `.p` package, version bump).
- **AnimeIto-P 16.20** carries the two `lib/m3u8server` fixes upstream still
  lacks (re-verified with `patches/verify_fix.py`). Same signing key as before,
  so installs update in place.
- **Retired:** Anikoto-P, AnimeSogo-P, AniWave-P, AnimeKai-P (upstream replaced
  the stream path those fixes were for), Animetsu-P (site dead, removed
  upstream) and Miruro-P (removed upstream).
- `package_repo.py` reads package, version and source ids from the build's
  metadata, cross-checks them against the signed APK, and takes the keystore
  password from the environment; the password is no longer in any file.
- `anikku/build.sh`: one reproducible build from the pinned commit.

### Mirrors
- New `mirrors/mirror.py` (fetch, verify, retarget) and `mirrors/publish.sh`.
  Official LNReader, Anikku and Mihon (Keiyoushi) repositories mirrored on
  branches `mirror-lnreader`, `mirror-anikku`, `mirror-mihon`; every APK's
  signing certificate is checked against the repository key.
- The old in-tree backups (`anikku/backup-official/`, tracked; and an untracked
  `backup-official/` LNReader snapshot of 2026-07-13, 16 MB) were removed from
  the main tree in favour of the mirror branches. The untracked snapshot was
  deleted without first being recorded; it is reproducible from upstream
  commits `8bcdc2d` (plugins/v3.0.0) and `9958254` (master).

### Repository
- Published as `8Chronicle8/reader-repos`; the private-repo serving paths
  (token in URL, token-holding Worker) are gone from the docs and tools.
- `check.sh`: every check, one verdict.
