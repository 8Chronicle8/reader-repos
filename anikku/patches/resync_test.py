#!/usr/bin/env python3
"""Is the junk stripping byte-exact? Test the invariant that matters.

After stripping, an MPEG-TS segment MUST have 0x47 at every 188-byte stride.
If it doesn't, the stream is misaligned and downstream parsers (like the
aac_adtstoasc bitstream filter on the audio stream) choke on garbage.

Compares the current magic-byte heuristic against a resync-based strategy.
"""
import random

from autodetect_sim import detect_interleaved_skips, TS_PKT, TS_SYNC
from verify_fix import detect_fixed

PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xFF\xD8\xFF\xE0"
GIF = b"GIF89a"


def make_ts(n_packets, pid=256, seed=0):
    rng = random.Random(seed)
    buf = bytearray()
    for i in range(n_packets):
        b1 = (1 << 6) | ((pid >> 8) & 0x1F)
        buf += bytes([TS_SYNC, b1, pid & 0xFF, 0x10])
        buf += bytes(rng.getrandbits(8) for _ in range(TS_PKT - 4))
    return bytes(buf)


def inject(ts, junk_sizes, seed=0):
    """Insert junk blocks at packet boundaries, like a real obfuscator."""
    rng = random.Random(seed)
    n = len(ts) // TS_PKT
    spots = sorted(rng.sample(range(1, n), len(junk_sizes)))
    out = bytearray()
    prev = 0
    for spot, size in zip(spots, junk_sizes):
        out += ts[prev * TS_PKT: spot * TS_PKT]
        magic = rng.choice([PNG, JPEG, GIF])
        out += magic + bytes(rng.getrandbits(8) for _ in range(size - len(magic)))
        prev = spot
    out += ts[prev * TS_PKT:]
    return bytes(out)


def strip(data, regions):
    out = bytearray()
    cur = 0
    for s, e, _ in regions:
        if s > cur:
            out += data[cur:s]
        cur = e
    out += data[cur:]
    return bytes(out)


def resync_strip(data):
    """Emit only bytes that form a valid 188-byte TS packet grid.

    Junk of any size at any offset is dropped, because a junk block simply
    fails the sync check and we scan forward to where the grid resumes.
    """
    out = bytearray()
    i = 0
    n = len(data)
    while i + TS_PKT <= n:
        if data[i] == TS_SYNC:
            out += data[i:i + TS_PKT]
            i += TS_PKT
            continue
        j = i + 1
        while j + TS_PKT <= n:
            if data[j] == TS_SYNC and (
                j + 2 * TS_PKT > n or data[j + TS_PKT] == TS_SYNC
            ):
                break
            j += 1
        i = j
    return bytes(out)


def ts_aligned(data):
    """Every 188-byte stride must start with the sync byte."""
    if not data or len(data) % TS_PKT:
        return False, f"length {len(data)} not a multiple of {TS_PKT}"
    bad = [i for i in range(0, len(data), TS_PKT) if data[i] != TS_SYNC]
    return (not bad), (f"{len(bad)} misaligned packets" if bad else "aligned")


def main():
    clean = make_ts(2000)
    print(f"clean TS: {len(clean)} bytes, {len(clean)//TS_PKT} packets\n")

    # Real obfuscators do NOT all use 252 bytes; vary it.
    for label, sizes in [
        ("all 252B (the assumed size)", [252] * 6),
        ("mixed sizes", [252, 300, 188, 512, 96, 252]),
        ("odd sizes", [137, 401, 63, 733, 250, 255]),
    ]:
        data = inject(clean, sizes, seed=len(label))
        exp = len(clean)
        print(f"--- {label} ---")
        for name, fn in [("current heuristic", detect_fixed), ("resync", None)]:
            got = resync_strip(data) if fn is None else strip(data, fn(data))
            ok, why = ts_aligned(got)
            delta = len(got) - exp
            print(f"  {name:<18} {len(got):>8}B (Δ{delta:+6})  {'VALID TS' if ok else 'CORRUPT'}: {why}")
        print()


if __name__ == "__main__":
    main()
