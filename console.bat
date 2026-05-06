@echo off
:menu
cls
title BuenzliFight - Dev Console

echo.
echo  ============================================
echo    BuenzliFight - Dev Console
echo  ============================================
echo.
echo   [1]  Server starten         (Backend Port 4100)
echo   [2]  Browser Dev starten    (Next.js Port 3000)
echo   [3]  Steam Debug starten    (dist + DevTools -console)
echo   [4]  Steam Build erstellen  (EXE / Steam Upload)
echo   [5]  Steam Upload           (zu Steam hochladen)
echo   [6]  Setup / Install        (npm install + Icon)
echo.
echo   [0]  Beenden
echo.
set /p CHOICE="Auswahl: "

if "%CHOICE%"=="1" ( start "Server" cmd /k "cd /d "%~dp0" && start-server.bat" & goto menu )
if "%CHOICE%"=="2" ( start "Browser Dev" cmd /k "cd /d "%~dp0" && start_game.bat" & goto menu )
if "%CHOICE%"=="3" ( call "%~dp0steam-debug.bat" & goto menu )
if "%CHOICE%"=="4" ( call "%~dp0build-windows.bat" & goto menu )
if "%CHOICE%"=="5" ( call "%~dp0steam-upload.bat" & goto menu )
if "%CHOICE%"=="6" ( call "%~dp0electron-setup.bat" & goto menu )
if "%CHOICE%"=="0" ( exit )

goto menu
