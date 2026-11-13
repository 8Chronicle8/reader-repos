#!/usr/bin/env bash
# One-time setup for working on this project.
set -e
echo "[*] Python deps (optional Pillow for icon conversion)..."
pip install --user pillow 2>/dev/null || pip install --break-system-packages pillow 2>/dev/null || true
echo "[*] Node deps for the test harness..."
cd test && npm init -y >/dev/null 2>&1 || true
npm install cheerio >/dev/null 2>&1
cd ..
echo "[*] Playwright (for capturing hidden APIs on SPA sites)..."
pip install --user playwright 2>/dev/null || pip install --break-system-packages playwright 2>/dev/null || true
python3 -m playwright install chromium 2>/dev/null || \
  echo "    (run 'python3 -m playwright install chromium' manually if that failed)"
echo "[+] Done. See DEVELOPMENT.md for project notes."
