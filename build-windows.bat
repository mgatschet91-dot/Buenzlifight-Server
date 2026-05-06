@echo off
setlocal EnableDelayedExpansion
title BuenzliFight - Windows Build

echo.
echo ============================================
echo   BuenzliFight - Windows EXE Build
echo ============================================
echo.

:: ─── Pfade ───────────────────────────────────
set ROOT=%~dp0
set NEXT_DIR=%ROOT%mapGame
set ELECTRON_DIR=%ROOT%electron-app

:: ─── 1. Icon generieren (falls nicht vorhanden) ───
if not exist "%ELECTRON_DIR%\build\icon.ico" (
    echo [1/5] Generiere Icon...
    node "%ELECTRON_DIR%\scripts\generate-icon.js"
    if errorlevel 1 ( echo FEHLER: Icon-Generierung fehlgeschlagen & pause & exit /b 1 )
) else (
    echo [1/5] Icon vorhanden - ueberspringe.
)

:: ─── 2. Next.js bauen ────────────────────────
echo.
echo [2/5] Next.js bauen (mapGame - Electron Build)...
echo       Das dauert ~2-5 Minuten...
echo.

cd /d "%NEXT_DIR%"

:: node_modules prüfen
if not exist "%NEXT_DIR%\node_modules" (
    echo       node_modules fehlen - installiere...
    npm install
    if errorlevel 1 ( echo FEHLER: npm install fehlgeschlagen & pause & exit /b 1 )
)

:: cross-env sicherstellen
if not exist "%NEXT_DIR%\node_modules\.bin\cross-env.cmd" (
    echo       cross-env fehlt - installiere devDependencies...
    npm install --include=dev
    if errorlevel 1 ( echo FEHLER: cross-env install fehlgeschlagen & pause & exit /b 1 )
)

:: Electron Build: standalone output + Produktion-URLs
set NEXT_PUBLIC_CORE_API_URL=https://core.buenzlifight.ch
set NEXT_PUBLIC_AUTH_API_URL=https://core.buenzlifight.ch
set NEXT_PUBLIC_WEBSOCKET_URL=https://core.buenzlifight.ch
set NEXT_PUBLIC_MULTIPLAYER_MODE=laravel-delta
set NEXT_PUBLIC_DEFAULT_MUNICIPALITY=zurich

npm run build:electron
if errorlevel 1 (
    echo.
    echo FEHLER: Next.js Build fehlgeschlagen!
    pause
    exit /b 1
)

echo.
echo [2/5] Next.js Build fertig!

:: ─── 3. Statische Dateien kopieren ───────────
echo.
echo [3/5] Statische Dateien kopieren...

xcopy /E /I /Y "%NEXT_DIR%\.next\static" "%NEXT_DIR%\.next\standalone\.next\static" >nul

if exist "%NEXT_DIR%\.next\standalone\public" (
    rmdir /S /Q "%NEXT_DIR%\.next\standalone\public"
)
xcopy /E /I /Y "%NEXT_DIR%\public" "%NEXT_DIR%\.next\standalone\public" >nul

echo [3/5] Dateien kopiert.

:: ─── 4. Code-Schutz: Bytecode kompilieren ────
echo.
echo [4/5] Code-Schutz: main.js + preload.js zu V8-Bytecode...

cd /d "%ELECTRON_DIR%"

if not exist "%ELECTRON_DIR%\node_modules" (
    echo       node_modules fehlen - installiere...
    npm install
    if errorlevel 1 ( echo FEHLER: npm install fehlgeschlagen & pause & exit /b 1 )
)

.\node_modules\.bin\electron scripts/protect.js
if errorlevel 1 (
    echo.
    echo FEHLER: Code-Schutz fehlgeschlagen!
    pause
    exit /b 1
)

echo [4/5] Bytecode fertig.

:: ─── 5. Electron bauen ────────────────────────
echo.
echo [5/5] Electron bauen...
echo       Das dauert ~3-8 Minuten...
echo.
echo  Welchen Build willst du?
echo  [1] NSIS-Installer (.exe Setup) — fuer direkte Weitergabe
echo  [2] Steam-Build (win-unpacked)  — fuer Steam Upload
echo.
set /p BUILD_TYPE="Eingabe (1 oder 2): "

cd /d "%ELECTRON_DIR%"

if "%BUILD_TYPE%"=="2" (
    echo.
    echo Baue Steam-Version (win-unpacked)...
    npm run dist:steam
) else (
    echo.
    echo Baue NSIS-Installer...
    npm run dist
)

if errorlevel 1 (
    echo.
    echo FEHLER: Electron Build fehlgeschlagen!
    pause
    exit /b 1
)

:: ─── Fertig ───────────────────────────────────
echo.
echo ============================================
echo   BUILD ERFOLGREICH!
if "%BUILD_TYPE%"=="2" (
    echo   Output: electron-app\dist\win-unpacked\
    echo   Naechster Schritt: steam-upload.bat starten
) else (
    echo   Output: electron-app\dist\
)
echo   Schutz: main.jsc + preload.jsc (V8-Bytecode)
echo ============================================
echo.

explorer "%ELECTRON_DIR%\dist"
pause
