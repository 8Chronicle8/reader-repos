#!/bin/sh
# Commit a fetched mirror directory onto its own branch (mirror-<name>), without
# touching the working tree. Each run adds one commit on top of the branch, so
# earlier snapshots stay in its history; unchanged files cost nothing.
#
#   mirrors/publish.sh <name> <mirror-dir> <owner/repo>
#
# The manifests are retargeted first, so the branch can be added in the app as
# it stands (see mirrors/README.md). Push the branch afterwards with
#   git push origin mirror-<name>
set -eu
NAME=${1:?lnreader|anikku|mihon}; DIR=$(cd "${2:?mirror dir}" && pwd); REPO=${3:?owner/repo}
HERE=$(cd "$(dirname "$0")" && pwd)
BRANCH="mirror-$NAME"
BASE="https://raw.githubusercontent.com/$REPO/$BRANCH"

python3 -I "$HERE/mirror.py" verify "$NAME" --dir "$DIR"
python3 -I "$HERE/mirror.py" retarget "$NAME" --dir "$DIR" --base-url "$BASE"

# Build the tree in a private index so the checkout's own index is untouched.
# (git refuses an existing empty file as an index, so it gets a fresh directory)
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
INDEX=$TMPD/index
GIT_INDEX_FILE=$INDEX git --work-tree="$DIR" add -A --force .
TREE=$(GIT_INDEX_FILE=$INDEX git write-tree)
SUMMARY=$(python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('; '.join('%s %s@%s' % (u['repo'], u['branch'], u['commit'][:7]) for u in d['upstream']))" "$DIR/SNAPSHOT.json")
PARENT=$(git rev-parse --verify --quiet "refs/heads/$BRANCH" || true)
if [ -n "$PARENT" ] && [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  echo "$BRANCH already holds this snapshot"; exit 0
fi
MSG="Mirror snapshot: $SUMMARY"
COMMIT=$(git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "$MSG")
git update-ref "refs/heads/$BRANCH" "$COMMIT" ${PARENT:+"$PARENT"}
echo "$BRANCH -> $(git rev-parse --short "$COMMIT"): $MSG"
