@echo off
setlocal EnableDelayedExpansion
title BuenzliFight - Electron Setup

echo.
echo ============================================
echo   BuenzliFight - Electron Dev Setup
echo ============================================
echo.

set ROOT=%~dp0

:: ─── mapGame: npm install ────────────────────
echo [1/3] mapGame - Abhaengigkeiten installieren...
cd /d "%ROOT%mapGame"
npm install
if errorlevel 1 ( echo FEHLER: mapGame npm install & pause & exit /b 1 )
echo       OK.

:: ─── electron-app: npm install ───────────────
echo.
echo [2/3] electron-app - Abhaengigkeiten installieren...
cd /d "%ROOT%electron-app"
npm install
if errorlevel 1 ( echo FEHLER: electron-app npm install & pause & exit /b 1 )
echo       OK.

:: ─── Icon generieren ─────────────────────────
echo.
echo [3/3] Icon generieren...
if not exist "%ROOT%electron-app\build\icon.ico" (
    node "%ROOT%electron-app\scripts\generate-icon.js"
    if errorlevel 1 ( echo FEHLER: Icon-Generierung & pause & exit /b 1 )
    echo       Icon erstellt.
) else (
    echo       Icon vorhanden - ueberspringe.
)

echo.
echo ============================================
echo   Setup fertig! Starte mit: electron-dev.bat
echo ============================================
echo.
pause
