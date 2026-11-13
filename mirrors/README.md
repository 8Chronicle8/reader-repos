# Mirrors of the official repositories

Copies of the official extension repositories, kept so the apps keep working
if an upstream disappears. Each mirror lives on its own branch, laid out
exactly as the app expects, so the branch can be added in the app as it is.

| Branch | Upstream | Add in the app |
|---|---|---|
| `mirror-lnreader` | [LNReader/lnreader-plugins](https://github.com/LNReader/lnreader-plugins) `plugins/v3.0.0` (+ `master` source in `source/`) | `https://raw.githubusercontent.com/8Chronicle8/reader-repos/mirror-lnreader/plugins/.dist/plugins.min.mirror.json` |
| `mirror-anikku` | [mojuru/anime-repo](https://github.com/mojuru/anime-repo) `repo` (Yūzōnō) | `https://raw.githubusercontent.com/8Chronicle8/reader-repos/mirror-anikku/index.min.json` |
| `mirror-mihon` | [keiyoushi/extensions](https://github.com/keiyoushi/extensions) `repo` + its release APKs | `https://raw.githubusercontent.com/8Chronicle8/reader-repos/mirror-mihon/index.mirror.pb` |

The original manifests are kept byte for byte. LNReader and Mihon manifests
carry absolute URLs, so each mirror also has a rewritten copy pointing at the
mirror itself (`*.mirror.*`); Anikku's are relative and work unchanged.
`SNAPSHOT.json` on each branch records the upstream commits and the fetch time.

Snapshot of 2026-11-13:

| Mirror | Contents | Size |
|---|---|---|
| LNReader | 372 plugins, compiled JS, icons, TypeScript source | 24 MB |
| Anikku | 248 extensions / 302 sources, APKs and icons | 45 MB |
| Mihon | 1,603 extensions / 2,591 sources, APKs and icons | 146 MB |

## What is checked

`mirror.py verify` fails on any of: a manifest entry without its file, an APK
that is not a zip, an APK whose signing certificate is not the repository's
signing key (the same check the apps make before installing), an icon that is
not an image, an empty manifest, and for Mihon, `index.pb` and `index.json`
disagreeing. A few upstream icons are JPEG or WebP files named `.png`; the apps
decode them by content, so they pass and are listed in the verify output.

## Not mirrored

- Mihon's `.jar` release assets: Mihon installs the APK and never reads them.
- Instruction files for AI coding agents that an upstream keeps in its source
  tree (`AGENTS.md` and similar): not used by the apps or a rebuild; each one
  left out is listed in the branch's `SNAPSHOT.json`.
- Extension *source* for Anikku and Mihon (130–240 MB each, with history); the
  published builds are what the apps install. LNReader plugins are mirrored
  with their source because they are small and readable.

## Refresh

```sh
python3 mirrors/mirror.py fetch mihon --out ../mirror-data/mihon     # resumable; lnreader | anikku | mihon
mirrors/publish.sh mihon ../mirror-data/mihon 8Chronicle8/reader-repos
git push origin mirror-mihon
```

`fetch` verifies before it finishes and exits non-zero on any failure; every
run leaves a log under `logs/`. `publish.sh` verifies again, writes the
retargeted manifests and adds one commit to the branch; earlier snapshots stay
in the branch history.
