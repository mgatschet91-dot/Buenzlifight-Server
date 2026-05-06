@echo off
title MeinOrt - Debug Browser (Port 3000, lokal)
cd /d "%~dp0mapGame"

echo.
echo ╔══════════════════════════════════════════════╗
echo ║     MeinOrt MapGame (Next.js)                ║
echo ╚══════════════════════════════════════════════╝
echo.

:: Lock-Datei entfernen falls vorhanden
if exist ".next\dev\lock" (
    echo [INFO] Entferne alte Lock-Datei...
    del /f ".next\dev\lock"
)

:: Prüfe ob node_modules existiert
if not exist "node_modules" (
    echo [INFO] Installiere Dependencies...
    call npm install
    echo.
)

echo [INFO] Starte Next.js (Browser/Debug, Port 3000, API: 127.0.0.1:4100)...
echo.
call npm run dev:local

pause
