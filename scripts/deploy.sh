#!/bin/sh
# deploy.sh — rebuild the SEO static pages from index.html, then commit & push.
# Usage:  sh scripts/deploy.sh "commit message"
# Run this instead of a bare `git push` after editing index.html, so the
# per-entry pages (knowledge/ column/ markets/) and sitemap.xml stay in sync.
set -e
cd "$(dirname "$0")/.."

echo "→ Regenerating SEO pages from index.html…"
node scripts/gen-pages.js

echo "→ Staging changes…"
git add index.html knowledge column markets assets sitemap.xml scripts/gen-pages.js scripts/deploy.sh .well-known robots.txt

if git diff --cached --quiet; then
  echo "Nothing to commit."
  exit 0
fi

git commit -m "${1:-Update site content and regenerate SEO pages}"
git push
echo "✓ Pushed to $(git branch --show-current)."
