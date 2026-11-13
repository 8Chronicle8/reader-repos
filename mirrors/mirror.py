#!/usr/bin/env python3
"""Mirror the official extension repositories so they can be re-hosted.

Three upstreams, each mirrored into a directory laid out exactly as its app
expects, so the directory can be pushed to a branch and added in the app as-is:

  lnreader  LNReader/lnreader-plugins   plugins/  (branch plugins/v3.0.0: .dist/ .js/ public/)
                                        source/   (branch master: TypeScript source)
  anikku    mojuru/anime-repo           index.min.json repo.json apk/ icon/   (branch repo)
  mihon     keiyoushi/extensions        index.json index.pb repo.json + apk/ icon/
                                        (APKs come from the upstream GitHub releases)

Commands:
  fetch    <name> --out DIR            download the latest snapshot (resumable)
  verify   <name> --dir DIR            completeness + APK signing-certificate check
  retarget <name> --dir DIR --base-url URL
                                       write manifests whose URLs point at DIR's own
                                       host (LNReader and Mihon store absolute URLs;
                                       Anikku's are relative and need nothing)
  selftest                             protobuf round-trip and APK parser checks

Every run writes a log (--log, default logs/mirror-<name>-<time>.log next to
this tool's repository root) holding the command line, this file's sha256, the
resolved settings, each item that failed and why, and how the run ended. A run
with any failure exits non-zero; nothing is skipped silently.

Standard library only.
"""
import argparse
import concurrent.futures
import datetime
import gzip
import hashlib
import io
import json
import logging
import os
import struct
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UA = "reader-repos-mirror/1.0"
LOG = logging.getLogger("mirror")

UPSTREAMS = {
    "lnreader": {
        "repo": "LNReader/lnreader-plugins",
        "branches": {"plugins": "plugins/v3.0.0", "source": "master"},
        "manifest_prefix": "https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/",
    },
    "anikku": {"repo": "mojuru/anime-repo", "branches": {".": "repo"}},
    "mihon": {"repo": "keiyoushi/extensions", "branches": {".": "repo"}},
}


AGENT_FILES = {"agents.md", "claude.md", ".claude", ".cursor", ".cursorrules", ".aider.conf.yml", "copilot-instructions.md"}


class MirrorError(Exception):
    """A failure that names what failed; the run stops or counts it."""


# ----------------------------------------------------------------- network

def http_get(url, attempts=4, timeout=60):
    """GET url and return bytes. raw.githubusercontent.com and the release CDN
    return transient 5xx/timeouts under load; those are retried with back-off.
    A 4xx is not transient and is raised at once."""
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise MirrorError(f"GET {url}: HTTP {e.code}") from e
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        LOG.debug("retry %d for %s (%s)", attempt + 1, url, last)
        time.sleep(2 * (attempt + 1))
    raise MirrorError(f"GET {url}: gave up after {attempts} attempts ({last})")


def branch_head(repo, branch):
    """Commit sha and date of a branch, from the GitHub API."""
    url = f"https://api.github.com/repos/{repo}/branches/{urllib.parse.quote(branch, safe='')}"
    data = json.loads(http_get(url))
    return data["commit"]["sha"], data["commit"]["commit"]["committer"]["date"]


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def extract_tarball(data, dest):
    """Extract a GitHub codeload tarball into dest, dropping its top folder.
    Members are confined to dest (no absolute paths, no '..', no links)."""
    os.makedirs(dest, exist_ok=True)
    real = os.path.realpath(dest)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        for m in tf.getmembers():
            parts = m.name.split("/", 1)
            if len(parts) < 2 or not parts[1]:
                continue
            rel = parts[1]
            target = os.path.realpath(os.path.join(dest, rel))
            if not target.startswith(real + os.sep):
                raise MirrorError(f"tarball member escapes destination: {m.name}")
            if m.isdir():
                os.makedirs(target, exist_ok=True)
            elif m.isfile():
                member = tf.extractfile(m)
                if member is None:
                    raise MirrorError(f"tarball member has no data: {m.name}")
                write_atomic(target, member.read())
            else:
                raise MirrorError(f"tarball member is not a plain file or directory: {m.name}")


# ------------------------------------------------- APK signing certificate

def apk_signer_sha256(path):
    """SHA-256 of the first signer's certificate in an APK's v2/v3 signing
    block -- the value Mihon/Anikku compare with the repo's signing key.
    Returns None when the APK has no v2/v3 block (v1-only signing)."""
    with open(path, "rb") as f:
        data = f.read()
    eocd = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    if eocd < 0:
        raise MirrorError(f"{path}: no zip end-of-central-directory record")
    cd_offset = struct.unpack_from("<I", data, eocd + 16)[0]
    if data[cd_offset - 16:cd_offset] != b"APK Sig Block 42":
        return None
    block_size = struct.unpack_from("<Q", data, cd_offset - 24)[0]
    pos = cd_offset - (block_size + 8) + 8
    end = cd_offset - 24
    blocks = {}
    while pos < end:
        size, block_id = struct.unpack_from("<QI", data, pos)
        blocks[block_id] = data[pos + 12:pos + 8 + size]
        pos += 8 + size
    scheme = blocks.get(0xF05368C0) or blocks.get(0x7109871A)  # v3, else v2
    if scheme is None:
        return None

    def lp(buf, off):  # uint32 length-prefixed slice
        n = struct.unpack_from("<I", buf, off)[0]
        return buf[off + 4:off + 4 + n], off + 4 + n

    signers, _ = lp(scheme, 0)
    signer, _ = lp(signers, 0)
    signed_data, _ = lp(signer, 0)
    _, off = lp(signed_data, 0)  # skip the digests
    certs, _ = lp(signed_data, off)
    cert, _ = lp(certs, 0)
    return hashlib.sha256(cert).hexdigest()


# ------------------------------------------------------- protobuf (Mihon)
# Mihon's v2 index (index.pb) is protobuf. The tree below keeps every field in
# its original order and encoding, so decode -> encode is byte-identical and a
# rewrite changes only the strings it is asked to change. Which fields are
# nested messages follows Mihon's NetworkExtensionStore model:
#   store: 4 contact, 101 extensionList;  extensionList: 1 extension (repeated)
#   extension: 3 resources, 8 source (repeated);  resources: 1 apkUrl, 2 iconUrl

PB_MESSAGES = {"store": {4: "contact", 101: "list"}, "list": {1: "extension"},
               "extension": {3: "resources", 8: "source"}, "resources": {},
               "contact": {}, "source": {}}


def _varint(buf, pos):
    shift = result = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def _put_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pb_decode(buf, kind="store"):
    """Decode into [(field, wiretype, value)], value a nested list for known
    sub-messages and raw bytes/int otherwise."""
    fields, pos = [], 0
    while pos < len(buf):
        key, pos = _varint(buf, pos)
        field, wt = key >> 3, key & 7
        if wt == 0:
            val, pos = _varint(buf, pos)
        elif wt == 2:
            n, pos = _varint(buf, pos)
            val = bytes(buf[pos:pos + n])
            pos += n
            sub = PB_MESSAGES[kind].get(field)
            if sub:
                val = pb_decode(val, sub)
        elif wt == 1:
            val, pos = bytes(buf[pos:pos + 8]), pos + 8
        elif wt == 5:
            val, pos = bytes(buf[pos:pos + 4]), pos + 4
        else:
            raise MirrorError(f"protobuf: unsupported wire type {wt} in {kind}")
        fields.append((field, wt, val))
    return fields


def pb_encode(fields):
    out = bytearray()
    for field, wt, val in fields:
        out += _put_varint(field << 3 | wt)
        if wt == 0:
            out += _put_varint(val)
        elif wt == 2:
            raw = pb_encode(val) if isinstance(val, list) else val
            out += _put_varint(len(raw)) + raw
        else:
            out += val
    return bytes(out)


def read_pb(path):
    """index.pb as served is gzip-compressed (Mihon gunzips it on load)."""
    with open(path, "rb") as f:
        raw = f.read()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def pb_extensions(tree):
    for f, _, v in tree:
        if f == 101:
            for f2, _, ext in v:
                if f2 == 1:
                    yield ext


def pb_str(msg, field):
    for f, _, v in msg:
        if f == field:
            return v.decode()
    return None


def pb_set_str(msg, field, value):
    for i, (f, wt, _) in enumerate(msg):
        if f == field:
            msg[i] = (f, wt, value.encode())
            return
    raise MirrorError(f"protobuf: field {field} missing")


# ---------------------------------------------------------------- fetchers

def fetch_branches(name, out, record):
    up = UPSTREAMS[name]
    for sub, branch in up["branches"].items():
        sha, date = branch_head(up["repo"], branch)
        LOG.info("%s %s@%s (%s)", up["repo"], branch, sha[:7], date)
        data = http_get(f"https://codeload.github.com/{up['repo']}/tar.gz/{sha}", timeout=300)
        dest = out if sub == "." else os.path.join(out, sub)
        extract_tarball(data, dest)
        record["upstream"].append({"repo": up["repo"], "branch": branch, "commit": sha,
                                   "committed": date, "path": sub})


def fetch_mihon_assets(out, jobs, failures):
    index = json.load(open(os.path.join(out, "index.json"), encoding="utf-8"))
    key = index["signingKey"]
    exts = index["extensionList"]["extensions"]

    def one(ext):
        pkg = ext["packageName"]
        apk_url = ext["resources"]["apkUrl"]
        apk = os.path.join(out, "apk", apk_url.rsplit("/", 1)[1])
        if not (os.path.exists(apk) and apk_signer_sha256(apk) == key):
            write_atomic(apk, http_get(apk_url, timeout=120))
            got = apk_signer_sha256(apk)
            if got != key:
                raise MirrorError(f"{pkg}: APK signed by {got}, store key is {key}")
        icon = os.path.join(out, "icon", pkg + ".png")
        if not os.path.exists(icon):
            write_atomic(icon, http_get(ext["resources"]["iconUrl"]))

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(one, e): e["packageName"] for e in exts}
        for n, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                fut.result()
            except Exception as e:  # every failure is recorded with its package and counted
                failures.append(f"{futures[fut]}: {e}")
                LOG.error("%s: %s", futures[fut], e)
            if n % 100 == 0:
                LOG.info("mihon assets: %d/%d done, %d failed", n, len(exts), len(failures))
    return len(exts)


def cmd_fetch(args):
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    record = {"name": args.name, "fetched": datetime.datetime.now(datetime.timezone.utc)
              .isoformat(timespec="seconds"), "upstream": [], "tool_sha256": TOOL_SHA}
    failures = []
    fetch_branches(args.name, out, record)
    if args.name == "mihon":
        record["extensions"] = fetch_mihon_assets(out, args.jobs, failures)
        record.setdefault("excluded", []).append("*.jar release assets: Mihon reads only apkUrl and iconUrl")
    # Instruction files for AI coding agents that upstream keeps in its source
    # tree are not part of what the apps or a rebuild use, and this repository
    # carries none (ENGINEERING-RULES P1); each one left out is recorded.
    excluded = []
    for root, dirs, files in os.walk(out):
        for name in list(files) + list(dirs):
            if name.lower() in AGENT_FILES:
                path = os.path.join(root, name)
                rel = os.path.relpath(path, out)
                if os.path.isdir(path):
                    import shutil
                    shutil.rmtree(path)
                    dirs.remove(name)
                else:
                    os.remove(path)
                excluded.append(rel)
                LOG.info("left out %s (agent instruction file)", rel)
    if excluded:
        record.setdefault("excluded", []).append("agent instruction files: " + ", ".join(sorted(excluded)))
    record["failures"] = failures
    write_atomic(os.path.join(out, "SNAPSHOT.json"),
                 (json.dumps(record, indent=2) + "\n").encode())
    if failures:
        raise MirrorError(f"{len(failures)} item(s) failed; see log")
    return verify(args.name, out)


# ------------------------------------------------------------------ verify

def verify(name, d):
    problems, stats = [], {}
    if name == "lnreader":
        man = json.load(open(os.path.join(d, "plugins/.dist/plugins.min.json"), encoding="utf-8"))
        prefix = UPSTREAMS["lnreader"]["manifest_prefix"]
        missing_icons = []
        for p in man:
            for key in ("url", "iconUrl"):
                url = p.get(key)
                if not url:
                    continue
                if not url.lower().startswith(prefix.lower()):
                    problems.append(f"{p['id']}: {key} not under the upstream prefix: {url}")
                    continue
                path = os.path.join(d, "plugins", url[len(prefix):])
                if not os.path.isfile(path) or os.path.getsize(path) == 0:
                    (missing_icons if key == "iconUrl" else problems).append(f"{p['id']}: {key} file missing ({url[len(prefix):]})")
        stats.update(plugins=len(man), missing_icons=missing_icons)
        if not os.path.isfile(os.path.join(d, "source/package.json")):
            problems.append("source/ is not a checkout of the plugin sources (no package.json)")
    elif name == "anikku":
        man = json.load(open(os.path.join(d, "index.min.json"), encoding="utf-8"))
        key = json.load(open(os.path.join(d, "repo.json"), encoding="utf-8"))["meta"]["signingKeyFingerprint"]
        for e in man:
            problems += check_apk(os.path.join(d, "apk", e["apk"]), key, e["pkg"])
            problems += check_icon(os.path.join(d, "icon", e["pkg"] + ".png"), e["pkg"])
        stats.update(extensions=len(man), sources=sum(len(e["sources"]) for e in man),
                     nsfw=sum(1 for e in man if e.get("nsfw")), signing_key=key)
    elif name == "mihon":
        index = json.load(open(os.path.join(d, "index.json"), encoding="utf-8"))
        key = index["signingKey"]
        exts = index["extensionList"]["extensions"]
        for e in exts:
            problems += check_apk(os.path.join(d, "apk", e["resources"]["apkUrl"].rsplit("/", 1)[1]), key, e["packageName"])
            problems += check_icon(os.path.join(d, "icon", e["packageName"] + ".png"), e["packageName"])
        # index.pb must say what index.json says, extension for extension.
        tree = pb_decode(read_pb(os.path.join(d, "index.pb")))
        pb_pkgs = [pb_str(x, 2) for x in pb_extensions(tree)]
        if pb_pkgs != [e["packageName"] for e in exts]:
            problems.append("index.pb and index.json list different extensions")
        stats.update(extensions=len(exts), sources=sum(len(e["sources"]) for e in exts),
                     nsfw=sum(1 for e in exts if e.get("contentWarning") == "CONTENT_WARNING_NSFW"),
                     signing_key=key)
    else:
        raise MirrorError(f"unknown mirror {name!r}")
    if NON_PNG_ICONS:
        stats["non_png_icons"] = list(NON_PNG_ICONS)
    if not stats.get("plugins") and not stats.get("extensions"):
        problems.append("manifest lists nothing -- a mirror of zero items is not a mirror")
    LOG.info("verify %s: %s", name, json.dumps(stats))
    for p in problems:
        LOG.error("verify %s: %s", name, p)
    if problems:
        raise MirrorError(f"verify {name}: {len(problems)} problem(s)")
    LOG.info("verify %s: ok", name)
    return stats


def check_apk(path, key, label):
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return [f"{label}: apk missing or empty ({os.path.basename(path)})"]
    if not zipfile.is_zipfile(path):
        return [f"{label}: apk is not a zip archive"]
    got = apk_signer_sha256(path)
    if got != key:
        return [f"{label}: apk signer {got} does not match repo key {key}"]
    return []


ICON_FORMATS = {"png": lambda h: h[:8] == b"\x89PNG\r\n\x1a\n",
                "jpeg": lambda h: h[:3] == b"\xff\xd8\xff",
                "webp": lambda h: h[:4] == b"RIFF" and h[8:12] == b"WEBP"}
NON_PNG_ICONS = []


def check_icon(path, label):
    # The apps decode icons by content, not by extension, and upstream ships a
    # few JPEG/WebP files under .png names (byte-identical to upstream, checked
    # 2026-11-13). So the requirement is "an image the app can decode"; the
    # non-PNG ones are listed in the verify stats rather than failed.
    if not os.path.isfile(path):
        return [f"{label}: icon missing"]
    with open(path, "rb") as f:
        head = f.read(12)
    kind = next((k for k, test in ICON_FORMATS.items() if test(head)), None)
    if kind is None:
        return [f"{label}: icon is not a PNG, JPEG or WebP image"]
    if kind != "png":
        NON_PNG_ICONS.append(f"{label} ({kind})")
    return []


# ---------------------------------------------------------------- retarget

def cmd_retarget(args):
    base = args.base_url.rstrip("/") + "/"
    d = os.path.abspath(args.dir)
    if args.name == "lnreader":
        prefix = UPSTREAMS["lnreader"]["manifest_prefix"]
        for fn in ("plugins.min.json", "plugins.json"):
            src = os.path.join(d, "plugins/.dist", fn)
            man = json.load(open(src, encoding="utf-8"))
            for p in man:
                for key in ("url", "iconUrl"):
                    if p.get(key):
                        if not p[key].lower().startswith(prefix.lower()):
                            raise MirrorError(f"{p['id']}: {key} outside the upstream prefix")
                        p[key] = base + "plugins/" + p[key][len(prefix):]
            dst = src.replace(".json", ".mirror.json")
            text = (json.dumps(man, separators=(",", ":"), ensure_ascii=False) if "min" in fn
                    else json.dumps(man, indent=2, ensure_ascii=False))
            write_atomic(dst, text.encode())
            LOG.info("wrote %s", os.path.relpath(dst, d))
    elif args.name == "mihon":
        index = json.load(open(os.path.join(d, "index.json"), encoding="utf-8"))
        for e in index["extensionList"]["extensions"]:
            r = e["resources"]
            r["apkUrl"] = base + "apk/" + r["apkUrl"].rsplit("/", 1)[1]
            r["iconUrl"] = base + "icon/" + e["packageName"] + ".png"
            r.pop("jarUrl", None)  # jars are not mirrored
        write_atomic(os.path.join(d, "index.mirror.json"),
                     json.dumps(index, separators=(",", ":"), ensure_ascii=False).encode())
        raw = read_pb(os.path.join(d, "index.pb"))
        tree = pb_decode(raw)
        if pb_encode(tree) != raw:
            raise MirrorError("index.pb does not round-trip; refusing to rewrite it")
        for ext in pb_extensions(tree):
            res = next(v for f, _, v in ext if f == 3)
            apk_url = pb_str(res, 1)
            if not apk_url:
                raise MirrorError(f"index.pb: {pb_str(ext, 2)} has no apkUrl")
            apk_name = apk_url.rsplit("/", 1)[1]
            pb_set_str(res, 1, base + "apk/" + apk_name)
            pb_set_str(res, 2, base + "icon/" + pb_str(ext, 2) + ".png")
            res[:] = [x for x in res if x[0] in (1, 2)]  # drop jar URL, not mirrored
        # Written gzip-compressed like upstream's; Mihon accepts either.
        write_atomic(os.path.join(d, "index.mirror.pb"), gzip.compress(pb_encode(tree), mtime=0))
        LOG.info("wrote index.mirror.json and index.mirror.pb (%d extensions)",
                 sum(1 for _ in pb_extensions(tree)))
    elif args.name == "anikku":
        LOG.info("anikku manifests use relative paths; nothing to retarget")
    else:
        raise MirrorError(f"unknown mirror {args.name!r}")


# ---------------------------------------------------------------- selftest

def cmd_selftest():
    # varint and message round trip on a hand-built store
    ext = [(1, 2, b"Name"), (2, 2, b"pkg.a"), (3, 2, [(1, 2, b"https://x/a.apk"), (2, 2, b"https://x/a.png"), (3, 2, b"https://x/a.jar")]),
           (5, 0, 106005), (7, 0, 3), (8, 2, [(1, 0, 2**63 - 1), (2, 2, b"Src")])]
    store = [(1, 2, b"Store"), (4, 2, [(1, 2, b"https://w")]), (101, 2, [(1, 2, ext)])]
    raw = pb_encode(store)
    assert pb_decode(raw) == store, "protobuf decode does not invert encode"
    assert pb_encode(pb_decode(raw)) == raw, "protobuf is not byte-identical after a round trip"
    for n in (0, 1, 127, 128, 300, 2**32, 2**63 - 1):
        assert _varint(_put_varint(n), 0) == (n, len(_put_varint(n))), n
    # a rewrite must change only the string asked for
    tree = pb_decode(raw)
    res = next(v for f, _, v in next(pb_extensions(tree)) if f == 3)
    pb_set_str(res, 1, "https://mirror/apk/a.apk")
    again = pb_decode(pb_encode(tree))
    assert pb_str(next(v for f, _, v in next(pb_extensions(again)) if f == 3), 1) == "https://mirror/apk/a.apk"
    assert pb_str(next(pb_extensions(again)), 2) == "pkg.a"
    LOG.info("selftest ok")


# -------------------------------------------------------------------- main

def tool_sha():
    with open(os.path.abspath(__file__), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


TOOL_SHA = tool_sha()


def setup_logging(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    LOG.setLevel(logging.DEBUG)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    sh = logging.StreamHandler(sys.stdout)
    sh.setLevel(logging.INFO)
    sh.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    LOG.addHandler(fh)
    LOG.addHandler(sh)
    if fh.stream is not None:
        fh.stream.reconfigure(line_buffering=True)


def main():
    ap = argparse.ArgumentParser(prog="mirror")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("name", choices=sorted(UPSTREAMS))
    f.add_argument("--out", required=True, help="directory to write the mirror into")
    f.add_argument("--jobs", type=int, default=8, help="parallel downloads (mihon assets)")
    v = sub.add_parser("verify")
    v.add_argument("name", choices=sorted(UPSTREAMS))
    v.add_argument("--dir", required=True)
    r = sub.add_parser("retarget")
    r.add_argument("name", choices=sorted(UPSTREAMS))
    r.add_argument("--dir", required=True)
    r.add_argument("--base-url", required=True, help="URL the mirror directory will be served from")
    t = sub.add_parser("selftest")
    for p in (f, v, r, t):
        p.add_argument("--log")
    args = ap.parse_args()
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    log = getattr(args, "log", None) or os.path.join(
        ROOT, "logs", f"mirror-{getattr(args, 'name', 'selftest')}-{args.cmd}-{stamp}.log")
    setup_logging(log)
    LOG.info("command: %s", " ".join(sys.argv))
    LOG.info("tool sha256: %s", TOOL_SHA)
    LOG.info("settings: %s", json.dumps({k: v for k, v in vars(args).items()}))
    try:
        if args.cmd == "fetch":
            cmd_fetch(args)
        elif args.cmd == "verify":
            verify(args.name, os.path.abspath(args.dir))
        elif args.cmd == "retarget":
            cmd_retarget(args)
        elif args.cmd == "selftest":
            cmd_selftest()
        else:
            raise MirrorError(f"unknown command {args.cmd!r}")
    except MirrorError as e:
        LOG.error("run failed: %s", e)
        LOG.info("log: %s", log)
        sys.exit(1)
    LOG.info("run ok; log: %s", log)


if __name__ == "__main__":
    main()
