#!/usr/bin/env python3
"""Refined resync: stricter anchor, and only applied to MPEG-TS content."""
import random

from autodetect_sim import TS_PKT, TS_SYNC
from verify_fix import detect_fixed
from resync_test import make_ts, inject, strip, ts_aligned

SYNC_RUN = 4  # consecutive 188-strides required to trust a resync point


def is_sync_run(data, off, runs=SYNC_RUN):
    n = len(data)
    for k in range(runs):
        p = off + k * TS_PKT
        if p >= n:
            return k >= 2  # near the tail, a shorter run is acceptable
        if data[p] != TS_SYNC:
            return False
    return True


def looks_like_ts(data):
    """True if a solid TS grid exists anywhere in the first 64 KB."""
    limit = min(len(data), 64 * 1024)
    for off in range(limit):
        if data[off] == TS_SYNC and is_sync_run(data, off, 5):
            return True
    return False


def resync_strip_v2(data):
    out = bytearray()
    i, n = 0, len(data)
    # find first trustworthy anchor
    while i < n and not (data[i] == TS_SYNC and is_sync_run(data, i)):
        i += 1
    while i + TS_PKT <= n:
        if data[i] == TS_SYNC:
            out += data[i:i + TS_PKT]
            i += TS_PKT
            continue
        j = i + 1
        while j + TS_PKT <= n and not (data[j] == TS_SYNC and is_sync_run(data, j)):
            j += 1
        if j + TS_PKT > n:
            break
        i = j
    return bytes(out)


def main():
    clean = make_ts(2000)
    exp = len(clean)
    print(f"clean TS: {exp} bytes ({exp//TS_PKT} packets)\n")
    cases = [
        ("all 252B", [252] * 6),
        ("mixed sizes", [252, 300, 188, 512, 96, 252]),
        ("odd sizes", [137, 401, 63, 733, 250, 255]),
        ("many small", [64] * 20),
        ("one huge", [9000]),
    ]
    print(f"{'case':<14} {'heuristic':<28} {'resync v2':<28}")
    print("-" * 72)
    allok = True
    for label, sizes in cases:
        data = inject(clean, sizes, seed=len(label))
        h = strip(data, detect_fixed(data))
        r = resync_strip_v2(data)
        hok, hwhy = ts_aligned(h)
        rok, rwhy = ts_aligned(r)
        allok &= rok
        print(f"{label:<14} {('OK' if hok else 'CORRUPT')+f' Δ{len(h)-exp:+}':<28} "
              f"{('OK' if rok else 'CORRUPT')+f' Δ{len(r)-exp:+}':<28}")
    print()
    # regression: clean TS must pass through untouched
    r = resync_strip_v2(clean)
    print(f"clean TS untouched by resync: {r == clean}")
    # non-TS content must be left alone by the gate
    mp4 = b"\x00\x00\x00\x18ftypmp42" + bytes(random.Random(0).getrandbits(8) for _ in range(4000))
    print(f"non-TS (mp4) detected as TS: {looks_like_ts(mp4)}  (must be False)")
    print()
    print("RESYNC ALWAYS VALID" if allok else "*** resync failed a case ***")


if __name__ == "__main__":
    main()
