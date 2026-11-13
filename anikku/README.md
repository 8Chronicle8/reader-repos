# Anikku extension repo (patched builds)

Extensions for [Anikku](https://github.com/komikku-app/anikku) rebuilt from the
official [Yūzōnō anime-extensions](https://github.com/yuzono/anime-extensions)
source with fixes that upstream does not have yet. Each one installs **next to**
the official extension as a `-P` variant, so nothing has to be uninstalled.

## Add it in Anikku

**Settings → Browse → Extension repos → Add**, and enter the base URL (Anikku
appends `/index.min.json`, `/apk/…` and `/icon/…` itself):

```
https://raw.githubusercontent.com/8Chronicle8/reader-repos/main/anikku/patched
```

Every APK is checked against the signing fingerprint in `patched/repo.json`:

```
304491c40ccada54da1a825d77397861e96ae88577e681cb2f90463bb4a4144d
```

## What is in it

| Extension | Version | Why it exists |
|---|---|---|
| AnimeIto-P (`pt.animeito.p`) | 16.20 | Two fixes to the shared HLS segment server (`lib/m3u8server`), which official AnimeIto still uses: see [EXTENSION-FIXES.md](EXTENSION-FIXES.md) |

### Retired on 2026-11-13

These were in this repo until the rebuild on the latest upstream. Their
entries are gone from the index, so Anikku marks an installed copy as
obsolete; uninstall it, and migrate the library to the official source
(**Browse → Migrate**).

| Extension | Reason |
|---|---|
| Anikoto-P, AnimeSogo-P, AniWave-P, AnimeKai-P | Upstream rewrote the Anikoto theme's stream handling (it now uses the player page's own host map), so the local stream-repair path these builds fixed no longer exists. The official extensions are newer and carry no equivalent bug. |
| Animetsu-P | The site is gone; upstream removed the source ("Remove Dead Source", 2026-08-14). |
| Miruro-P | Upstream removed the source ("Remove Useless Source", 2026-09-29). |

## Side-by-side builds

| | why |
|---|---|
| applicationId gets `.p` | Android will not install two APKs with one package name, and with a different key it is a hard failure, not an update |
| the class meta-data is absolute | the manifest names the source class relative to the applicationId, which no longer matches after the suffix |
| the R8 keep rule names the real class | otherwise the release build strips the class the manifest points at |
| names get `-P` | the source id is `md5(name/lang/versionId)`; a new name gives a new id on purpose, so the two sources never shadow each other |

Because the id differs, a `-P` source starts with an empty library. Move
entries over with **Browse → Migrate**, which keeps progress.

## Rebuilding

```sh
ANIKKU_KEYSTORE=/path/to/anikku-signing-key.jks ANIKKU_KEYSTORE_PASS=... \
  anikku/build.sh <work-dir> <build-number>
```

`build.sh` checks out the pinned upstream commit, applies
`patches/m3u8server-fixes.patch`, runs `patches/apply_private_build.py` (the
`-P` build switches in Gradle's build logic), builds only the listed modules,
then `patches/package_repo.py` signs the APKs, checks each against its build
metadata and the key, and rewrites `patched/`. Raise `<build-number>` on every
rebuild; Anikku only offers an update when the version code goes up.

**Pinned upstream:** `yuzono/anime-extensions@227457f` (2026-11-13). When
moving the pin, re-check that each fix is still needed (see
EXTENSION-FIXES.md) and that `apply_private_build.py` still applies; it stops
with a message if upstream moved any line it edits.

Requires JDK 17+, Android SDK build-tools 36.0.0, and the keystore
([SIGNING-KEY.md](SIGNING-KEY.md)).

## Official repository backup

A mirror of the official Yūzōnō repo is published on the `mirror-anikku`
branch; see [../mirrors/README.md](../mirrors/README.md).
