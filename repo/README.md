# LNReader Plugin Repository

A community-style plugin repository for [LNReader](https://www.lnreader.app/),
laid out like the official `lnreader-plugins` repo.

## Add to LNReader

Browse → gear icon → **Add repository**:

```
https://raw.githubusercontent.com/8Chronicle8/reader-repos/main/repo/.dist/plugins.min.json
```

## Run your own copy

Fork the repository, then rebuild the manifest against your fork so every
plugin URL points at it:
`python3 lnrepo.py build --github <you>/<repo> --branch main --subdir repo`.

## Layout

```
.dist/
  plugins.min.json      manifest served to LNReader (minified)
  plugins.json          same, pretty-printed for diffs
icons/
  <id>.png              plugin icons
src/plugins/english/
  <id>.js               plugin source (plain CommonJS, LNReader v3 API)
```

## Plugins

| Plugin | Site | Type |
|---|---|---|
| The Sun Is Cold | thesuniscold.translatednovels.com | WordPress REST |
| Doby Translations | dobytranslations.com | LightNovelWP |
| Penguin Squad | penguin-squad.com | Next.js embedded JSON |
| Boti Translation | botitranslation.com | StoryWave JSON API |
| Noice Translations | noicetranslations.com | Madara |
| Primodial Translation | primodialtranslation.com | LightNovelWP |
| HangukHub | hangukhub.com | Next.js embedded JSON |
| TapToTale | taptotale.com | WordPress (category=novel) |
| Novellunar | novellunar.com | Next.js App Router RSC |
| NovelDex | noveldex.io | Next.js App Router RSC |
| Curspe | curspe.com | WordPress (webnovel/chapter CPTs) |
| Bright Novels | brightnovels.com | Laravel + Inertia.js SPA |
| WuxiaWorld.site | wuxiaworld.site | Madara |
| Zetro Translation | zetrotranslation.com | Madara |
| Genesis Studio | genesistudio.com | Next.js RSC + Directus CMS |


Paid/subscriber chapters (Penguin Squad, Boti, NovelDex, Bright Novels,
Genesis Studio) are shown with a 🔒 and cannot be read without an account.

## Generated with

The `lnrepo.py` tool in the parent project. It auto-detects the site type
(WordPress themes, Next.js, generic SPA+API, or generic HTML) and generates
a matching plugin, then builds this `.dist/` manifest.

## Disclaimer

Independent, community-built plugins for the open-source
[LNReader](https://github.com/LNReader/lnreader) app — **not affiliated with or
endorsed by** any of the source websites. This repository hosts plugin **code
only**; it does not host, store, or redistribute any novel content — plugins
fetch pages directly from each site on the user's device. Paid/subscriber
chapters are marked 🔒 and are never bypassed. Source-site owners can request
removal by opening an
[issue](https://github.com/8Chronicle8/reader-repos/issues/new);
removed sites are not re-added. Provided as is, for personal use (MIT License).
