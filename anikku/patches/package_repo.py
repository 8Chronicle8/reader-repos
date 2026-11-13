#!/usr/bin/env python3
"""Sign built "-P" extensions and write the Anikku extension repo for them.

usage:
  ANIKKU_KEYSTORE_PASS=... package_repo.py --ext <anime-extensions checkout> \\
      --module pt/animeito [--module ...] --out <repo dir> --keystore <file.jks> \\
      --website <url of this repository>

For each module it takes the release APK the build produced and the build's own
keiyoushi-source-info.json (package, name, version, source ids), zipaligns and
signs the APK, then proves the result before listing it: the APK's package and
version must match the metadata, its signer must be the keystore's key, and
apksigner must accept it. The icon is the module's own launcher icon.

The keystore password is read from ANIKKU_KEYSTORE_PASS and never written
anywhere. Nothing is signed when it is missing.

<out> receives index.min.json and index.json (Anikku's legacy index format,
matching the official repo's fields), repo.json with the signing fingerprint,
apk/ and icon/. Entries already in <out> for modules not built this run are
dropped: the index lists exactly what was packaged.
"""
import argparse
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys

SDK = os.environ.get("ANDROID_HOME") or os.path.expanduser("~/Android/Sdk")
BT = os.path.join(SDK, "build-tools", "36.0.0")
NSFW_WARNINGS = {2, 3}  # ContentWarning MIXED and NSFW are flagged nsfw=1, as upstream does


class PackageError(Exception):
    pass


def run(cmd, env=None):
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise PackageError(f"{os.path.basename(cmd[0])} failed:\n{r.stdout}\n{r.stderr}")
    return r.stdout


def badging(apk):
    out = run([os.path.join(BT, "aapt2"), "dump", "badging", apk])
    line = next((l for l in out.splitlines() if l.startswith("package:")), "")
    fields = dict(part.split("=", 1) for part in line.split()[1:] if "=" in part)
    return {k: v.strip("'") for k, v in fields.items()}


def signer_sha256(apk):
    out = run([os.path.join(BT, "apksigner"), "verify", "--print-certs", apk])
    for line in out.splitlines():
        if "certificate SHA-256 digest:" in line:
            return line.rsplit(":", 1)[1].strip()
    raise PackageError(f"{apk}: apksigner printed no signer digest")


def package_module(ext, module, out, keystore, alias, password):
    lang, name = module.split("/")
    build = os.path.join(ext, "src", lang, name, "build")
    info_path = os.path.join(build, "keiyoushi-source-info.json")
    apks = glob.glob(os.path.join(build, "outputs", "apk", "release", "*.apk"))
    if not os.path.exists(info_path) or len(apks) != 1:
        raise PackageError(f"{module}: expected one release APK and keiyoushi-source-info.json "
                           f"under {build} (found {len(apks)} APK(s)); build it first")
    with open(info_path, encoding="utf-8") as f:
        info = json.load(f)
    if not info["packageName"].endswith(".p"):
        raise PackageError(f"{module}: {info['packageName']} is not a private (-P) build; "
                           "build with -PprivateSuffix=p")
    apk_name = os.path.basename(apks[0]).replace("-release", "")
    dest = os.path.join(out, "apk", apk_name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    run([os.path.join(BT, "zipalign"), "-p", "-f", "4", apks[0], dest + ".part"])
    env = dict(os.environ, KS_PASS=password)
    run([os.path.join(BT, "apksigner"), "sign", "--ks", keystore, "--ks-key-alias", alias,
         "--ks-pass", "env:KS_PASS", "--key-pass", "env:KS_PASS",
         "--v4-signing-enabled", "false", dest + ".part"], env=env)
    os.replace(dest + ".part", dest)
    run([os.path.join(BT, "apksigner"), "verify", dest])
    b = badging(dest)
    if b.get("name") != info["packageName"] or int(b.get("versionCode", -1)) != info["versionCode"]:
        raise PackageError(f"{module}: APK says {b.get('name')} v{b.get('versionCode')}, "
                           f"metadata says {info['packageName']} v{info['versionCode']}")
    icon_src = os.path.join(ext, "src", lang, name, "res", "mipmap-xhdpi", "ic_launcher.png")
    if not os.path.exists(icon_src):
        raise PackageError(f"{module}: no launcher icon at {icon_src}")
    os.makedirs(os.path.join(out, "icon"), exist_ok=True)
    shutil.copyfile(icon_src, os.path.join(out, "icon", info["packageName"] + ".png"))
    langs = {s["lang"] for s in info["sources"]}
    entry = {
        "name": "Private: " + info["name"],
        "pkg": info["packageName"],
        "apk": apk_name,
        "lang": langs.pop() if len(langs) == 1 else "all",
        "code": info["versionCode"],
        "version": info["versionName"],
        "nsfw": 1 if info["contentWarning"] in NSFW_WARNINGS else 0,
        "torrent": 1 if info.get("isTorrent") else 0,
        "sources": [{"name": s["name"], "lang": s["lang"], "id": str(s["id"]), "baseUrl": s["baseUrl"]}
                    for s in info["sources"]],
    }
    return entry, signer_sha256(dest)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ext", required=True)
    ap.add_argument("--module", action="append", required=True, help="<lang>/<name>, repeatable")
    ap.add_argument("--out", required=True)
    ap.add_argument("--keystore", required=True)
    ap.add_argument("--alias", default="anikku")
    ap.add_argument("--website", required=True)
    args = ap.parse_args()
    password = os.environ.get("ANIKKU_KEYSTORE_PASS")
    if not password:
        sys.exit("ANIKKU_KEYSTORE_PASS is not set; refusing to sign")
    out = os.path.abspath(args.out)
    try:
        packaged = [package_module(os.path.abspath(args.ext), m, out, args.keystore, args.alias, password)
                    for m in args.module]
    except PackageError as e:
        sys.exit(str(e))
    fingerprints = {fp for _, fp in packaged}
    if len(fingerprints) != 1:
        sys.exit(f"expected one signing key, got {sorted(fingerprints)}")
    entries = sorted((e for e, _ in packaged), key=lambda e: e["name"])
    keep = {e["apk"] for e in entries}, {e["pkg"] + ".png" for e in entries}
    for sub, names in zip(("apk", "icon"), keep):
        for f in os.listdir(os.path.join(out, sub)):
            if f not in names:
                os.remove(os.path.join(out, sub, f))
                print(f"  - removed {sub}/{f} (not in this build)")
    with open(os.path.join(out, "index.min.json"), "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
    repo = {"meta": {"name": "Anikku Private (patched)", "shortName": "Private",
                     "website": args.website, "signingKeyFingerprint": fingerprints.pop()}}
    with open(os.path.join(out, "repo.json"), "w", encoding="utf-8") as f:
        json.dump(repo, f, ensure_ascii=False, indent=2)
    for e in entries:
        print(f"  + {e['name']}  v{e['version']}  {e['apk']}")
    print(f"signing fingerprint: {repo['meta']['signingKeyFingerprint']}")
    print("sha256 index.min.json:", hashlib.sha256(open(os.path.join(out, "index.min.json"), "rb").read()).hexdigest())


if __name__ == "__main__":
    main()
