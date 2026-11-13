# reader-repos

Extension repositories for three open-source reader apps, plus tools to
generate, test and back them up:

| App | What is here | Add this URL in the app |
|---|---|---|
| [LNReader](https://github.com/LNReader/lnreader) | 13 novel-site plugins (`repo/`) | `https://raw.githubusercontent.com/8Chronicle8/reader-repos/main/repo/.dist/plugins.min.json` |
| [Anikku](https://github.com/komikku-app/anikku) | patched anime extensions (`anikku/`) | `https://raw.githubusercontent.com/8Chronicle8/reader-repos/main/anikku/patched/index.min.json` |
| LNReader, Anikku, [Mihon](https://github.com/mihonapp/mihon) | mirrors of the official repositories | see [mirrors/README.md](mirrors/README.md) |

- **LNReader:** Settings → Repositories → Add (the plugin names end in `-P`, so
  they sit next to the official plugins).
- **Anikku:** Settings → Browse → Extension repos → Add. Anikku only accepts a
  URL ending in `/index.min.json`; it finds `apk/` and `icon/` next to it.

## LNReader plugins

| Plugin | Site | Filters | Hide locked chapters |
|---|---|---|---|
| Boti Translation-P | botitranslation.com | sort (popular, translations, words, updated), genre, status | yes |
| Bright Novels-P | brightnovels.com | – | yes |
| Doby Translations-P | dobytranslations.com | genre, type, status, order | – (paid chapters are not listed) |
| Fenrir Realm-P | fenrirealm.com | sort, status, genres | yes |
| Genesis Studio-P | genesistudio.com | sort, genres | yes |
| NovelDex-P | noveldex.io | sort, type, status, origin, genre/tag include+exclude, chapters | yes |
| Noice Translations-P | noicetranslations.com | genre, status, author, artist, year, adult, order | yes |
| Novellunar-P | novellunar.com | – | – |
| Penguin Squad-P | penguin-squad.com | – | yes |
| Primodial Translation-P | primodialtranslation.com | genre, type, status, order | – (paid chapters are not listed) |
| TapToTale-P | taptotale.com | – | – |
| The Sun Is Cold-P | thesuniscold.translatednovels.com | – | – |
| WuxiaWorld.site-P | wuxiaworld.site | genre, status, author, artist, year, adult, order | yes |

"Hide locked chapters" is in each plugin's settings. Locked (paid) chapters are
listed with a 🔒 and are never unlocked: the plugins read only what a site
serves to any visitor.

Two sites need a one-time check in the app's WebView before they load:

- **Fenrir Realm** asks for a captcha before it starts a reading session. Open
  a chapter in WebView (globe icon), wait until its text shows, go back and
  reload. The plugin then renews the session before it expires, across app
  restarts, until the site asks for a new check. If a chapter still fails, the
  error ends with a short `[...]` line; that line says where it stopped.
- **Novellunar** is behind a Cloudflare check; pass it once in WebView.

Bright Novels can optionally route through a proxy you run
([tools/cf-worker.js](tools/cf-worker.js)); set it in the plugin's settings if
the site refuses the app's connections.

## Working on the plugins

```sh
./setup.sh                                      # test dependencies (node modules)
python3 lnrepo.py add <url> --name "Name"       # generate a plugin for a new site
python3 lnrepo.py filters <id>                  # read a LightNovelWP site's filter form
python3 lnrepo.py regen <id>                    # re-emit a template plugin
python3 tools/private_common.py sync            # shared plugin code (hide locked chapters)
python3 lnrepo.py build --github 8Chronicle8/reader-repos --branch main --subdir repo --no-icons
./check.sh --live                               # every check, one verdict
```

Run one plugin against its live site:

```sh
cd test && node harness.js ../repo/src/plugins/english/<id>.js [search] [--hide-locked] [--filters '<json>']
```

Notes on each site and the generator are in [DEVELOPMENT.md](DEVELOPMENT.md);
what changed and why is in [CHANGES.md](CHANGES.md).

## Layout

```
repo/                 LNReader repository (what the app reads)
  .dist/              manifest
  src/plugins/        plugin code        filters/   per-site filter data
lnrepo.py             plugin generator and manifest builder
tools/                shared plugin block, filter extraction, proxy Worker, API capture
test/                 live harness, Fenrir offline tests
anikku/               Anikku repository (patched/), its build and patches
mirrors/              mirror tool for the official repositories
check.sh              all checks
```

## Disclaimer

This is an independent, community-built project. It is **not affiliated with,
endorsed by, or connected to** LNReader, Anikku, Mihon, Keiyoushi, Yūzōnō, or
any site the plugins and extensions read from.

- **No third-party content is hosted here.** The repository holds plugin and
  extension *code*. They fetch from each source site on the user's own device
  at read or watch time; nothing is stored, copied, or redistributed here. The
  mirror branches hold unmodified copies of the official repositories' published
  extension builds, which are open-source software.
- **Access controls are respected.** Paid or subscriber-only chapters are marked
  🔒 and never unlocked; checks a site asks a person to complete are left to the
  person.
- **Removal / takedown.** If you own or represent a source site and want its
  plugin removed, open an [issue](https://github.com/8Chronicle8/reader-repos/issues/new)
  and it will be removed promptly.
- Provided **as is**, for personal use, under the [MIT License](LICENSE). Users
  are responsible for complying with the terms of service and laws that apply to
  what they access.
