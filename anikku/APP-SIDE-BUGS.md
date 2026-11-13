# Anikku app-side defects — noted, not fixed

These live in the Anikku APK, not in any extension, so the patched repo in
`patched/` cannot fix them. Recorded here so they can be filed upstream at
[komikku-app/anikku](https://github.com/komikku-app/anikku/issues).

Observed on Anikku 0.1.7 (`52278b0846`, build 8814), Android 16 / SM-S948B,
ffmpeg n7.1.

---

## 1. `-map 0:v` is a non-optional glob — the download killer

`Downloader.kt:636` builds the per-episode ffmpeg command as:

```
-headers '…' -i "<video.m3u8>" [-i <subs>] [-i <audio>]
-map 0:v <audioMaps> -map 0:a? <subMaps> -map 0:s? -map 0:t?
-f matroska -c:a copy -c:v copy -c:s copy
"<file>.tmp" -y
```

Note `-map 0:v` next to `0:a?`, `0:s?`, `0:t?` — **it is the only one missing
the `?`**, and it is a glob over *every* video-typed stream, not just the real
one. Any stray stream ffmpeg classifies as video gets copied into the output.

When the input carries a bogus PNG stream (see `EXTENSION-FIXES.md` for where
that came from), the result is:

```
[hls] Could not find codec parameters for stream 0 (Video: png, none): unspecified size
[matroska] dimensions not set
[out#0/matroska] Could not write header (incorrect codec parameters ?): Invalid argument
[sost#0:3/copy] Error initializing output stream:
```

Matroska requires width/height on every video track, the header write fails,
ffmpeg exits non-zero, and `Downloader.kt:595` turns that into the user-facing
`Error in ffmpeg!`.

**Suggested fix:** `-map 0:V?`. Uppercase `V` matches video streams *excluding*
attached pictures and thumbnails; `?` stops it erroring when nothing matches.
That is the correct specifier for "the actual video, not cover art". If a
problem stream is not flagged `attached_pic`, the filter needs to be
codec-based instead — but the missing `?` is a defect regardless of this
particular trigger.

**Related upstream:** [aniyomiorg/aniyomi#2126](https://github.com/aniyomiorg/aniyomi/issues/2126)
— same "ffmpeg dies at the Matroska mux" class, different trigger, still open.

## 2. No `-analyzeduration` / `-probesize`

Anikku passes neither (zero occurrences in `Downloader.kt`), so ffmpeg reports
`analyzeduration (0)` and gives up probing immediately. A stream whose codec
parameters need more than the default probe window can never be resolved. Not
the root cause here, but it removes the one lever that might have let ffmpeg
recover the dimensions rather than failing.

## 3. `-f matroska` is hardcoded

There is no user-facing setting to change the output container, so a user
hitting a Matroska-specific muxing limitation has no in-app workaround at all.

## 4. ADM external-downloader path reports false success

`Downloader.kt:727-739` — the ADM (`com.dv.adm`) branch deletes the temp file
and directory, sets `status = DOWNLOADED`, and removes the entry from the queue
**at the moment the intent is fired**, before ADM has transferred a single byte.
Anikku reports the download succeeded regardless of what actually happened.

ADM also can't handle HLS (it's a plain multi-threaded HTTP downloader — it
would fetch the few-KB `.m3u8` playlist text and stop), and its headers are
passed through a `.replace("http", "h_ttp")` escaping workaround (`:710`).

**Use 1DM instead** (`idm.internet.download.manager*`), which parses m3u8 and
receives headers as a proper Bundle. Caveat: Anikku sends an explicit save path
only to ADM (`ACTION_LIST_PATH`, `:722`); for 1DM it just copies the folder to
your clipboard (`:670`) and you must paste it into 1DM's save-location field,
or the file lands outside the temp dir and
`ensureSuccessfulAnimeDownload` (`:772-786`) won't count it as downloaded.

## 5. External-downloader whitelist mismatch

`SettingsDownloadScreen.kt:259-267` whitelists four exact package names, but
the download handler matches with `startsWith`. Net effect: **ADM Pro
(`com.dv.adm.pay`) is handled by the downloader but can never be selected in
settings.** Selecting "None" while the external toggle is on falls through to a
generic `ACTION_VIEW` intent that passes **no headers at all** (`:743-747`),
which 403s on most sources.

---

## Not bugs — log noise

`Adreno-AppProfiles: QSPM AIDL service doesn't exist`, `libpenguin.so not
found`, `SQLiteLog (283)/(284)`, `VibratorInfo`, `Kumiho`, `ashmem` are normal
Samsung/Android chatter. `MangaScreenModel: JobCancellationException` and
`StandaloneCoroutine: ForgottenCoroutineScopeException` are benign lifecycle
cancellations from navigating away from a screen.

Neither captured log contains an actual crash — every line is `E`-level and
nothing terminated the process.
