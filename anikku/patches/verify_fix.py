#!/usr/bin/env python3
"""Before/after for the AutoDetector fixes.

Proves three things:
  1. the PID-2374 collision no longer shreds clean video
  2. random false positives on clean TS are eliminated
  3. REAL disguise blocks are still stripped (no regression)
"""
import random

import autodetect_sim as old
from autodetect_sim import TS_PKT, TS_SYNC, DEFAULT_JUNK_BLOCK_SIZE, JUNK_END_SEARCH_LIMIT
from pid_collision import make_ts_with_pid

PNG = b"\x89PNG"
JPEG = b"\xFF\xD8\xFF"


def detect_junk_block_end_fixed(d, offset):
    n = len(d)
    is_jpeg = offset + 2 < n and d[offset:offset + 3] == JPEG
    is_png = offset + 3 < n and d[offset:offset + 4] == PNG
    # full 6-byte GIF signature
    is_gif = (offset + 5 < n and d[offset:offset + 3] == b"GIF" and
              d[offset + 3] == ord("8") and d[offset + 4] in (ord("7"), ord("9")) and
              d[offset + 5] == ord("a"))
    if not (is_jpeg or is_png or is_gif):
        return -1, None
    # TS-grid guard
    if old.is_mpeg_ts_valid_at(d, offset):
        return -1, None
    kind = "JPEG" if is_jpeg else ("PNG" if is_png else "GIF")

    search_end = min(n, offset + JUNK_END_SEARCH_LIMIT)
    i = offset + 1
    while i < search_end:
        if i + 8 <= search_end and old.is_ftyp_at(d, i):
            return i, kind
        if i + 12 <= search_end and old.is_riff_avi_at(d, i):
            return i, kind
        if d[i] == TS_SYNC and old.is_mpeg_ts_valid_at(d, i):
            return i, kind
        i += 1
    return min(n, offset + DEFAULT_JUNK_BLOCK_SIZE), kind


def detect_fixed(d):
    regions, i, n = [], 0, len(d)
    while i < n - 2:
        end, kind = detect_junk_block_end_fixed(d, i)
        if end >= 0:
            if end > i:
                regions.append((i, end, kind))
            i = end
        else:
            i += 1
    return regions


def lost(regions):
    return sum(e - s for s, e, _ in regions)


def make_disguised(pid=256, junk=b"\x89PNG" + b"\x00" * 248, seed=1, size=256 * 1024):
    """A REAL disguised segment: fake image header, then valid TS."""
    body = make_ts_with_pid(size, pid, seed=seed)
    return junk + body, len(junk)


def main():
    print("=" * 68)
    print("1. PID 2374 collision (512 KB clean TS, all packets on PID 2374)")
    print("=" * 68)
    seg = make_ts_with_pid(512 * 1024, 2374)
    b, a = old.detect_interleaved_skips(seg), detect_fixed(seg)
    print(f"  before: {len(b):>5} strips, {lost(b):>7} bytes destroyed ({100*lost(b)/len(seg):.1f}%)")
    print(f"  after:  {len(a):>5} strips, {lost(a):>7} bytes destroyed ({100*lost(a)/len(seg):.1f}%)")

    print()
    print("=" * 68)
    print("2. False positives on 8 x 2 MB of clean, junk-free TS")
    print("=" * 68)
    tb = ta = 0
    for seed in range(8):
        s = old.make_ts_segment(2 * 1024 * 1024, seed)
        tb += lost(old.detect_interleaved_skips(s))
        ta += lost(detect_fixed(s))
    print(f"  before: {tb:>7} bytes of real video deleted")
    print(f"  after:  {ta:>7} bytes of real video deleted")

    print()
    print("=" * 68)
    print("3. REGRESSION CHECK - real disguise blocks must still be stripped")
    print("=" * 68)
    ok = True
    for name, junk in [
        ("PNG  252B", b"\x89PNG\r\n\x1a\n" + bytes(244)),
        ("JPEG 252B", b"\xFF\xD8\xFF\xE0" + bytes(248)),
        ("GIF89a   ", b"GIF89a" + bytes(246)),
    ]:
        seg, junk_len = make_disguised(junk=junk)
        r = detect_fixed(seg)
        stripped = lost(r)
        good = len(r) >= 1 and r[0][0] == 0 and stripped >= junk_len - 8
        ok &= good
        print(f"  {name}: junk={junk_len:>4}B  stripped={stripped:>4}B  "
              f"first_range={r[0][:2] if r else None}  {'OK' if good else 'FAIL'}")

    print()
    print("all regression checks passed" if ok else "REGRESSION FAILED")


if __name__ == "__main__":
    main()
