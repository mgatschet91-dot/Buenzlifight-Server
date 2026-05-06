@echo off
title BuenzliFight - Steam Debug

set ROOT=%~dp0
set ELECTRON_DIR=%ROOT%electron-app
set DIST_DIR=%ROOT%electron-app\dist\win-unpacked
set ASAR=%DIST_DIR%\resources\app.asar
set TEMP=%TEMP%\bf-patch

echo.
echo ============================================
echo   BuenzliFight - Steam Debug (-console)
echo ============================================
echo.

if not exist "%DIST_DIR%\BuenzliFight.exe" (
    echo FEHLER: Erst build-windows.bat ausfuehren!
    pause & exit /b 1
)

:: 1. Neues Bytecode kompilieren
echo [1/3] Bytecode kompilieren...
cd /d "%ELECTRON_DIR%"
.\node_modules\.bin\electron.cmd "%ELECTRON_DIR%\scripts\protect.js"
if not exist "%ELECTRON_DIR%\main.jsc" ( echo FEHLER! & pause & exit /b 1 )

:: 2. Nur main.jsc im asar aktualisieren
echo [2/3] main.jsc ins dist patchen...
if exist "%TEMP%" rmdir /S /Q "%TEMP%"
"%ELECTRON_DIR%\node_modules\.bin\asar.cmd" extract "%ASAR%" "%TEMP%"
copy /Y "%ELECTRON_DIR%\main.js"  "%TEMP%\main.js"  >nul
copy /Y "%ELECTRON_DIR%\main.jsc" "%TEMP%\main.jsc" >nul
"%ELECTRON_DIR%\node_modules\.bin\asar.cmd" pack "%TEMP%" "%ASAR%"
rmdir /S /Q "%TEMP%"

:: 3. Starten mit -console (DevTools oeffnen sich automatisch)
echo [3/3] Starte mit DevTools...
echo.
echo   Tipp: In Steam Launch-Optionen auch "-console" setzen
echo.
cd /d "%DIST_DIR%"
BuenzliFight.exe -console

pause
