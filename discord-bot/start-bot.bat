@echo off
title MeinOrt Discord Bot
echo ========================================
echo   MeinOrt Discord Bot wird gestartet...
echo ========================================
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    echo [INFO] Node-Module fehlen. Installiere Dependencies...
    npm install
    echo.
)

if not exist ".env" (
    echo [FEHLER] .env Datei fehlt!
    echo Kopiere .env.example nach .env und trage dein Discord Token ein.
    echo.
    pause
    exit /b 1
)

echo [START] Bot laeuft... Druecke Ctrl+C zum Beenden.
echo.
node bot.js

echo.
echo [INFO] Bot wurde beendet.
pause
