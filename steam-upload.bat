@echo off
title BuenzliFight - Steam Upload

set STEAMCMD=C:\steamcmd\steamcmd.exe
set APP_BUILD=%~dp0electron-app\steamworks\app_build.vdf
set STEAM_USER=gatgat23

echo.
echo ============================================
echo   BuenzliFight - Steam Upload
echo   App ID: 4563360
echo ============================================
echo.

if not exist "%~dp0electron-app\dist\win-unpacked\BuenzliFight.exe" (
    echo FEHLER: Kein Build gefunden!
    echo Bitte zuerst build-windows.bat ausfuehren (Option 2).
    pause & exit /b 1
)

echo Build gefunden. Starte Upload...
echo.

"%STEAMCMD%" +login %STEAM_USER% +run_app_build "%APP_BUILD%" +quit

if errorlevel 1 (
    echo.
    echo Upload fehlgeschlagen!
    pause & exit /b 1
)

echo.
echo ============================================
echo   UPLOAD ERFOLGREICH!
echo   Jetzt auf Steamworks den Build publishen:
echo ============================================
echo.
start https://partner.steamgames.com/apps/builds/4563360
pause
