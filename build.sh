#!/bin/sh
# artifact.html : page content only (claude.ai adds the document skeleton)
# index.html    : standalone document for running locally (declares UTF-8)
set -e
cd "$(dirname "$0")"
{ cat shell.html; echo '<script>'; cat engine.js; echo; cat ui.js; echo '</script>'; } > artifact.html
{ printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n'; cat artifact.html; printf '\n</body>\n</html>\n'; } > index.html
echo "built artifact.html and index.html"
