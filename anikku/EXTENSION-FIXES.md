# Fixes in the patched builds

Patched against `yuzono/anime-extensions@227457f`; the diff is
`patches/m3u8server-fixes.patch`. Both fixes are in `lib/m3u8server`, the
local HLS segment server that some extensions run streams through. Upstream's
own description of it: it detects image headers prepended to video segments
and passes the video data on. Of the extensions in this repo, AnimeIto uses it.

## 1. A valid MPEG-TS packet was taken for a GIF header

`AutoDetector` matched a GIF by its first three bytes, `47 49 46`. `0x47` is
also the MPEG-TS sync byte, and `47 49 46` is a valid TS packet header
(payload-unit-start set, PID 0x946). Every such packet was treated as an image
header and cut out of the stream. On 512 KB of clean TS (`patches/verify_fix.py`, which runs a
Python model of `AutoDetector`; re-run 2026-11-13):

| | cuts | bytes removed |
|---|---|---|
| before | 2787 | 520,680 (99.3%) |
| after | 0 | 0 |

The check now requires the full six-byte signature (`GIF87a` / `GIF89a`), JPEG
requires a valid marker byte after `FF D8 FF`, and no cut may start at an
offset that sits on a valid TS packet grid. Real image headers of each kind
are still removed exactly (252 bytes in, 252 out, tested for PNG, JPEG and
GIF89a).

## 2. Segments that needed no change were changed

Most segments are plain MPEG-TS. A segment whose length is a multiple of 188
with the sync byte at every packet start cannot contain an inserted block, yet
the detector could still find a spurious match in one: a measured 1,811,944-byte
segment (9,638 packets) had one 33-byte false match, and removing it misaligned
5,008 of the remaining packets, which broke the audio track (ffmpeg's
`aac_adtstoasc` filter then fails). Such segments are now passed through
untouched (`isPristineMpegTs`), and any segment that was modified is re-aligned
to the 188-byte packet grid before it is served.

## Logging

The server logs a one-line summary of the first three segments of a session
at error level, because that is what Anikku's "Dump crash logs" captures.

## Fixes that are no longer carried

The August build also carried three fixes to the Anikoto theme (always routing
through the segment server, tolerating a mapper entry without a URL, and a
pinned NanoHTTPD). Upstream has since fixed the mapper entry itself and
replaced the stream path those fixes touched, so they were dropped along with
the builds that needed them (see the README).
