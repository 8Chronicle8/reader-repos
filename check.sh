#!/bin/sh
# Every check in one command, one verdict.
#
#   ./check.sh             offline checks
#   ./check.sh --live      also run every LNReader plugin against its live site
#   ./check.sh --release   offline + live, and a skipped check counts as a failure
#
# MIRROR_DATA points at the mirrors (default ../mirror-data); the Fenrir parity
# test and the mirror verification need it. A check that cannot run says SKIP
# with the reason, and the verdict counts it.
set -u
cd "$(dirname "$0")"
LIVE=0; RELEASE=0
for a in "$@"; do
  case "$a" in
    --live) LIVE=1 ;;
    --release) LIVE=1; RELEASE=1 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done
MIRROR_DATA=${MIRROR_DATA:-../mirror-data}
mkdir -p logs
pass=0; fail=0; skip=0
ok()   { echo "PASS $1"; pass=$((pass + 1)); }
bad()  { echo "FAIL $1"; fail=$((fail + 1)); }
skp()  { echo "SKIP $1"; skip=$((skip + 1)); }
step() { name=$1; shift; if "$@" > "logs/check-$(echo "$name" | tr ' /' '__').log" 2>&1; then ok "$name"; else bad "$name (logs/check-$(echo "$name" | tr ' /' '__').log)"; fi; }

step "mirror tool selftest" python3 -I mirrors/mirror.py selftest --log logs/check-mirror-selftest-run.log
step "shared plugin block" python3 -I tools/private_common.py check
for f in repo/src/plugins/*/*.js; do step "syntax $(basename "$f")" node --check "$f"; done
step "manifest lists every plugin" python3 -I -c "
import json
st = {p['id']: p for p in json.load(open('repo/sources.json'))['plugins']}
man = {p['id']: p for p in json.load(open('repo/.dist/plugins.min.json'))}
assert st and set(st) == set(man), (sorted(st), sorted(man))
for i, p in st.items():
    assert man[i]['version'] == p['version'], i
    src = open('repo/' + man[i]['url'].split('/main/repo/', 1)[1]).read()
    assert \"this.version = '%s'\" % p['version'] in src, i + ': plugin file version differs from manifest'
    if 'iconUrl' in man[i]:
        import os
        assert os.path.isfile('repo/' + man[i]['iconUrl'].split('/main/repo/', 1)[1]), i + ': iconUrl points at a missing file'
"

OFFICIAL_FENRIR="$MIRROR_DATA/lnreader/plugins/.js/src/plugins/english/fenrirrealm.js"
if [ -f "$OFFICIAL_FENRIR" ]; then
  step "fenrir token flow + parity" sh -c "cd test && node fenrir_crypto_test.js '$(realpath "$OFFICIAL_FENRIR")'"
else
  skp "fenrir parity: no official plugin at $OFFICIAL_FENRIR"
fi
for m in lnreader anikku mihon; do
  if [ -d "$MIRROR_DATA/$m" ]; then
    step "mirror $m verifies" python3 -I mirrors/mirror.py verify "$m" --dir "$MIRROR_DATA/$m" --log "logs/check-mirror-$m-verify-run.log"
  else
    skp "mirror $m: $MIRROR_DATA/$m not present"
  fi
done

if [ "$LIVE" = 1 ]; then
  for f in repo/src/plugins/*/*.js; do
    id=$(basename "$f" .js); extra=""
    grep -q "<private-common>" "$f" && extra="--hide-locked"
    if (cd test && timeout 240 node harness.js "../$f" $extra) > "logs/check-live-$id.log" 2>&1; then
      ok "live $id"
    elif grep -qE "WebView" "logs/check-live-$id.log"; then
      # A site that demands a human check (captcha / Cloudflare) cannot pass here.
      skp "live $id: site requires a check in WebView ($(grep -m1 FAIL "logs/check-live-$id.log" | cut -c7-80)...)"
    else
      bad "live $id (logs/check-live-$id.log)"
    fi
  done
else
  skp "live plugin runs: pass --live"
fi

echo "---"
echo "passed $pass, failed $fail, skipped $skip"
if [ "$fail" -gt 0 ] || { [ "$RELEASE" = 1 ] && [ "$skip" -gt 0 ]; }; then echo "VERDICT: FAIL"; exit 1; fi
echo "VERDICT: PASS"
