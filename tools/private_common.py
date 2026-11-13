#!/usr/bin/env python3
"""Keep the shared plugin block (tools/private_common.js) in step everywhere.

  sync    append or replace the block in every plugin that can list a locked
          chapter, and remove it from plugins that cannot
  check   exit non-zero if any plugin's copy differs from the canonical block,
          is missing where it belongs, or is present where it does not

A plugin "can list a locked chapter" when its source marks chapter names with
the 🔒 prefix (literally or as the \\uD83D\\uDD12 escape) outside the block.
The block must be the last thing in the file, after `exports.default = ...`.
"""
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CANON_PATH = os.path.join(HERE, "private_common.js")
PLUGINS = os.path.join(ROOT, "repo", "src", "plugins")
BLOCK_RX = re.compile(r"\n?// <private-common>\n.*?// </private-common>\n", re.S)
LOCK_RX = re.compile(r"🔒|\\uD83D\\uDD12", re.I)


def canonical():
    with open(CANON_PATH, encoding="utf-8") as f:
        return f.read()


def plugin_files():
    files = sorted(glob.glob(os.path.join(PLUGINS, "*", "*.js")))
    if not files:
        sys.exit(f"no plugins found under {PLUGINS}")
    return files


def split(text):
    blocks = BLOCK_RX.findall(text)
    return BLOCK_RX.sub("\n", text).rstrip("\n") + "\n", blocks


def wants_block(body):
    return bool(LOCK_RX.search(body))


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("sync", "check"):
        sys.exit(__doc__)
    mode, canon, problems = sys.argv[1], canonical(), []
    for path in plugin_files():
        name = os.path.relpath(path, ROOT)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        body, blocks = split(text)
        want = wants_block(body)
        if mode == "check":
            if len(blocks) > 1:
                problems.append(f"{name}: {len(blocks)} copies of the block")
            elif want and not blocks:
                problems.append(f"{name}: lists locked chapters but lacks the block")
            elif not want and blocks:
                problems.append(f"{name}: has the block but never marks a chapter locked")
            elif blocks and blocks[0].lstrip("\n") != canon:
                problems.append(f"{name}: block differs from tools/private_common.js")
            elif blocks and not text.endswith(canon):
                problems.append(f"{name}: block is not the last thing in the file")
            continue
        new = body + ("\n" + canon if want else "")
        if new != text:
            tmp = path + ".part"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(new)
            os.replace(tmp, path)
            print(f"  {'+' if want else '-'} {name}")
    if problems:
        print("\n".join(problems))
        sys.exit(1)
    if mode == "check":
        print(f"private-common: {len(plugin_files())} plugins consistent")


if __name__ == "__main__":
    main()
