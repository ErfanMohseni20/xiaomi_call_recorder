#!/usr/bin/env bash
# Builds callrec.dex inside the cimg/android image (JDK + Android SDK), no local SDK needed.
# Runs as root because the image keeps its SDK under a private home dir.
set -euo pipefail
cd "$(dirname "$0")"
OUT=${1:-../web/payload}
mkdir -p "$OUT"
docker run --rm -u 0 -e OWNER="$(id -u):$(id -g)" -v "$PWD:/src" -v "$(realpath "$OUT"):/out" -w /src cimg/android:2026.10.1 bash -ec '
  JAR=$ANDROID_HOME/platforms/android-35/android.jar
  D8=$ANDROID_HOME/build-tools/36.0.0/d8
  rm -rf /tmp/cls && mkdir -p /tmp/cls
  javac --release 11 -Xlint:-options -cp "$JAR" -d /tmp/cls $(find src -name "*.java")
  $D8 --release --min-api 30 --lib "$JAR" --output /tmp/cls $(find /tmp/cls -name "*.class")
  cp /tmp/cls/classes.dex /out/callrec.dex && chown "$OWNER" /out/callrec.dex
'
echo "built $OUT/callrec.dex"
