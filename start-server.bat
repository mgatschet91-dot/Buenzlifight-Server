@echo off
title MeinOrt - Server Core (Port 4100)
echo ============================================
echo   MeinOrt Server Core
echo   http://127.0.0.1:4100
echo   WebSocket: ws://127.0.0.1:4100
echo   Bobba WS:  ws://127.0.0.1:4100/bobba
echo ============================================
echo.
cd /d "%~dp0server-core"
node index.js
pause
