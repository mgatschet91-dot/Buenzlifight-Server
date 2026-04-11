#!/bin/bash

# ============================================================
# rebuild-client.sh — Next.js Client neu bauen & PM2 restart
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$SCRIPT_DIR/mapGame"
LOG_DIR="$SCRIPT_DIR/logs"
BUILD_LOG="$LOG_DIR/build.log"

mkdir -p "$LOG_DIR"

echo ""
echo "======================================"
echo "  meinort-client BUILD"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================"
echo ""

# --- Build ---
echo ">>> Baue Client in $CLIENT_DIR ..."
echo ""

cd "$CLIENT_DIR"

if npm run build 2>&1 | tee "$BUILD_LOG"; then
  echo ""
  echo "======================================"
  echo "  BUILD ERFOLGREICH"
  echo "======================================"
  echo ""

  # PM2 neustarten
  if pm2 describe meinort-client > /dev/null 2>&1; then
    echo ">>> Starte meinort-client in PM2 neu..."
    pm2 restart meinort-client
    echo ""
    pm2 show meinort-client | grep -E "status|restarts|uptime|memory"
    echo ""
    echo ">>> Done. Client läuft wieder."
  else
    echo ">>> meinort-client nicht in PM2 gefunden — starte neu..."
    cd "$SCRIPT_DIR"
    pm2 start ecosystem.config.js --only meinort-client
    pm2 save
    echo ">>> Done. Client gestartet und gespeichert."
  fi

else
  echo ""
  echo "======================================"
  echo "  BUILD FEHLGESCHLAGEN!"
  echo "======================================"
  echo ""
  echo ">>> Fehler-Log: $BUILD_LOG"
  echo ""
  echo "--- Letzte 50 Zeilen ---"
  tail -50 "$BUILD_LOG"
  echo ""
  echo ">>> PM2 wird NICHT neu gestartet."
  echo ">>> Alter Build läuft weiter bis du den Fehler behebst."
  exit 1
fi
