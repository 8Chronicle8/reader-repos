#!/usr/bin/env python3
"""Faithful port of AutoDetector.detectInterleavedSkips to measure how often it
strips REAL video data by mistake.

Mirrors lib/m3u8server/src/aniyomi/lib/m3u8server/AutoDetector.kt exactly.
"""
import os
import random

JPEG = b"\xFF\xD8\xFF"
PNG = b"\x89PNG"
GIF = b"GIF"
TS_SYNC = 0x47
TS_PKT = 188
DEFAULT_JUNK_BLOCK_SIZE = 252
JUNK_END_SEARCH_LIMIT = 8 * 1024


def is_mpeg_ts_valid_at(d, start):
    if start + TS_PKT > len(d):
        return False
    if d[start] != TS_SYNC:
        return False
    valid = 0
    j = start
    ceiling = min(len(d), start + 1024)
    while j < ceiling:
        if j + TS_PKT <= len(d) and d[j] == TS_SYNC:
            valid += 1
        j += TS_PKT
    return valid >= 2


def is_ftyp_at(d, o):
    return d[o + 4:o + 8] == b"ftyp"


def is_riff_avi_at(d, o):
    return d[o:o + 4] == b"RIFF" and d[o + 8:o + 12] == b"AVI "


def detect_junk_block_end(d, offset):
    n = len(d)
    is_jpeg = offset + 2 < n and d[offset:offset + 3] == JPEG
    is_png = offset + 3 < n and d[offset:offset + 4] == PNG
    is_gif = offset + 2 < n and d[offset:offset + 3] == GIF
    if not (is_jpeg or is_png or is_gif):
        return -1, None
    kind = "JPEG" if is_jpeg else ("PNG" if is_png else "GIF")

    search_end = min(n, offset + JUNK_END_SEARCH_LIMIT)
    i = offset + 1
    while i < search_end:
        if i + 8 <= search_end and is_ftyp_at(d, i):
            return i, kind
        if i + 12 <= search_end and is_riff_avi_at(d, i):
            return i, kind
        if d[i] == TS_SYNC and is_mpeg_ts_valid_at(d, i):
            return i, kind
        i += 1
    return min(n, offset + DEFAULT_JUNK_BLOCK_SIZE), kind


def detect_interleaved_skips(d):
    regions = []
    i = 0
    n = len(d)
    while i < n - 2:
        end, kind = detect_junk_block_end(d, i)
        if end >= 0:
            if end > i:
                regions.append((i, end, kind))
            i = end
        else:
            i += 1
    return regions


def make_ts_segment(size, seed=0):
    """Synthetic MPEG-TS: 0x47 sync every 188 bytes, random payload between.

    Real H.264/AAC payload is high-entropy, so random bytes are a fair stand-in
    for how often the magic sequences appear by chance.
    """
    rng = random.Random(seed)
    buf = bytearray(rng.getrandbits(8) for _ in range(size))
    for off in range(0, size - TS_PKT, TS_PKT):
        buf[off] = TS_SYNC
    return bytes(buf)


def main():
    print(f"{'segment':>10} {'false strips':>13} {'bytes lost':>11}  breakdown")
    print("-" * 62)
    totals = {}
    total_bytes = 0
    total_strips = 0
    for seed in range(8):
        size = 2 * 1024 * 1024  # 2 MB, a typical HLS segment
        seg = make_ts_segment(size, seed)
        regions = detect_interleaved_skips(seg)
        lost = sum(e - s for s, e, _ in regions)
        kinds = {}
        for _, _, k in regions:
            kinds[k] = kinds.get(k, 0) + 1
            totals[k] = totals.get(k, 0) + 1
        total_bytes += lost
        total_strips += len(regions)
        print(f"{size // 1024:>8}KB {len(regions):>13} {lost:>11}  {kinds}")

    print("-" * 62)
    print(f"across 8 x 2MB of clean, junk-free MPEG-TS:")
    print(f"  {total_strips} false junk blocks detected {totals}")
    print(f"  {total_bytes} bytes of real video silently deleted")
    print()
    print("Every one of these is a hole punched in valid video data.")


if __name__ == "__main__":
    main()
