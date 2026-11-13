#!/bin/sh
# Rebuild the private Anikku extensions from a pinned upstream commit.
#
#   ANIKKU_KEYSTORE=<file.jks> ANIKKU_KEYSTORE_PASS=<pass> anikku/build.sh <work-dir> <build-number>
#
# <build-number> is added to every versionCode (-PprivateBuild). Raise it on
# every rebuild: Anikku only offers an update when the index's code exceeds
# the installed one. Needs JDK 17+, ANDROID_HOME with build-tools 36.0.0, and
# network access for the first Gradle run.
set -eu
UPSTREAM=https://github.com/yuzono/anime-extensions
COMMIT=227457fbeed34e4808a89d288df6e5760142a5a4   # master on 2026-11-13; see README "Pinned upstream"
MODULES="pt/animeito"
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:?work directory}; BUILD=${2:?build number}
: "${ANIKKU_KEYSTORE:?set ANIKKU_KEYSTORE}" "${ANIKKU_KEYSTORE_PASS:?set ANIKKU_KEYSTORE_PASS}"

if [ ! -d "$WORK/.git" ]; then
  git clone --filter=blob:none "$UPSTREAM" "$WORK"
fi
cd "$WORK"
git fetch --depth 1 origin "$COMMIT" 2>/dev/null || true
git checkout --quiet --force "$COMMIT"
git apply "$HERE/patches/m3u8server-fixes.patch"
python3 -I "$HERE/patches/apply_private_build.py" .
# Configure only the modules being built (upstream's documented way to narrow).
sed -i 's/^loadAllIndividualExtensions()$/\/\/ loadAllIndividualExtensions()/' settings.gradle.kts
tasks=""
for m in $MODULES; do
  echo "loadIndividualExtension(\"${m%/*}\", \"${m#*/}\")" >> settings.gradle.kts
  tasks="$tasks :src:${m%/*}:${m#*/}:assembleRelease"
done
echo "sdk.dir=${ANDROID_HOME:?set ANDROID_HOME}" > local.properties
./gradlew --no-daemon -Dorg.gradle.jvmargs=-Xmx2560m -PprivateSuffix=p -PprivateBuild="$BUILD" $tasks
args=""
for m in $MODULES; do args="$args --module $m"; done
python3 -I "$HERE/patches/package_repo.py" --ext . $args --out "$HERE/patched" \
  --keystore "$ANIKKU_KEYSTORE" --website https://github.com/8Chronicle8/reader-repos
