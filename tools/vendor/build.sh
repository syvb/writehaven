#!/usr/bin/env bash
# Dev-time only. Rebuilds the pinned front-end bundles in public/vendor/.
#   cd tools/vendor && npm ci && ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../public/vendor
mkdir -p "$OUT"
BANNER='/*! Bundled third-party code (MIT and BSD licensed): see /vendor/LICENSES.txt for the licenses. */'
npx esbuild cm-entry.js --bundle --format=esm --minify --target=es2020 --legal-comments=eof --banner:js="$BANNER" --outfile="$OUT/cm.js"
npx esbuild interop-entry.js --bundle --format=esm --minify --target=es2020 --platform=browser --legal-comments=eof --banner:js="$BANNER" --outfile="$OUT/interop.js"
{ echo "$BANNER"; cat node_modules/mammoth/mammoth.browser.min.js; } > "$OUT/mammoth.js"
node licenses.mjs
ls -la "$OUT"
