#!/usr/bin/env bash
# Assembles php/dist: the PHP version as one folder to upload. It is the counterpart of
# `go build ./cmd/callrec-web`, which embeds the same files into the callrec-web binary.
# Run web/build.sh (and the payload builds) first.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/payload
cp index.php .htaccess ../web/index.html ../web/app.bundle.js dist/
cp ../web/payload/* dist/payload/
echo "php/dist ready: upload what is in it to a folder of an HTTPS site"
