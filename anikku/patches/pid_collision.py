#!/usr/bin/env python3
"""The GIF magic check collides with a real MPEG-TS packet header.

GIF magic as checked by AutoDetector is 3 bytes: 0x47 'G', 0x49 'I', 0x46 'F'.
But 0x47 is ALSO the MPEG-TS sync byte. So a TS packet header of
    47 49 46 ...
is a perfectly valid packet -- and gets shredded as a "GIF junk block".

Decoding what 47 49 46 means as a TS header:
    byte0 = 0x47                       sync
    byte1 = 0x49 = 0100 1001           TEI=0, payload_unit_start=1, prio=0,
                                       PID high 5 bits = 0b01001 = 9
    byte2 = 0x46                       PID low 8 bits = 0x46
    => PID = (9 << 8) | 0x46 = 0x946 = 2374

So EVERY packet-unit-start packet on PID 2374 begins with "GIF".
If a stream assigns PID 2374 to its video or audio track, every keyframe-
carrying packet on it is deleted.
"""
from autodetect_sim import detect_interleaved_skips, TS_PKT, TS_SYNC
import random


def make_ts_with_pid(size, pid, seed=0, start_flag=True):
    """Synthetic TS where every packet is on `pid` with payload_unit_start set."""
    rng = random.Random(seed)
    buf = bytearray()
    n = size // TS_PKT
    for _ in range(n):
        b1 = ((1 if start_flag else 0) << 6) | ((pid >> 8) & 0x1F)
        b2 = pid & 0xFF
        pkt = bytes([TS_SYNC, b1, b2, 0x10]) + bytes(rng.getrandbits(8) for _ in range(TS_PKT - 4))
        buf += pkt
    return bytes(buf)


def report(pid, size=512 * 1024):
    seg = make_ts_with_pid(size, pid)
    assert seg[0] == 0x47
    regions = detect_interleaved_skips(seg)
    lost = sum(e - s for s, e, _ in regions)
    pct = 100.0 * lost / len(seg)
    head = seg[:3].hex(" ")
    print(f"  PID {pid:>5} (0x{pid:04x})  header={head}  "
          f"strips={len(regions):>5}  bytes lost={lost:>7} ({pct:5.1f}% of segment)")


def main():
    print(__doc__)
    print("512 KB of clean, junk-free MPEG-TS, all packets on one PID:")
    print()
    for pid in (256, 257, 2374, 480, 4096):
        report(pid)
    print()
    print("PID 2374 is destroyed. The others pass through untouched.")
    print("Any stream whose muxer picks PID 2374 is corrupted beyond playback --")
    print("which is exactly 'it fails to play AND fails to download'.")


if __name__ == "__main__":
    main()
