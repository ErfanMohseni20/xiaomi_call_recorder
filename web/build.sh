#!/usr/bin/env bash
# Bundles the browser app. Run build-dex.sh and the Go cross-builds first so
# payload/ holds callrec.dex, callrecd-arm64 and callrecd-arm.
set -euo pipefail
cd "$(dirname "$0")"
npx esbuild src/app.js --bundle --format=esm --target=es2022 \
  --outfile=app.bundle.js "$@"
echo "bundled app.bundle.js"
