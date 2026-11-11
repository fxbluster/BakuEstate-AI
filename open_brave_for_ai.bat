@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - Brave Google AI Pro Launcher

set "BRAVE_EXE=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE_EXE%" (
    set "BRAVE_EXE=C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"
)
if not exist "%BRAVE_EXE%" (
    set "BRAVE_EXE=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"
)

if not exist "%BRAVE_EXE%" (
    echo [XETA] Brave Browser tapilmadi!
    pause
    exit /b 1
)

echo ========================================================================
echo        BAKU ESTATE AI - BRAVE BROWSER GOOGLE AI PRO LAUNCHER
echo ========================================================================
echo.
echo Bu fayl Brave brauzerini sizin oz gundelik profilinizle acir,
echo lakin Google AI Pro (Gemini) avtomatlasdirmasini aktiv edir.
echo.

tasklist /FI "IMAGENAME eq brave.exe" 2>NUL | find /I /N "brave.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo [BILDIRIS] Brave brauzeri hazirda aciqdir.
    echo Portu aktiv etmek ucun Brave-i baglayib yeniden aciriq...
    echo.
    echo Brave-i baglayib AI rejiminde acmaq ucun Enter duymesini basin.
    pause >nul
    taskkill /F /IM brave.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
)

echo [OK] Brave acilir (Port 9222 aktiv edilir, movcud profil ve hesablariniz yuklenir)...
start "" "%BRAVE_EXE%" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data" https://gemini.google.com/app

timeout /t 2 /nobreak >nul
echo.
echo ========================================================================
echo   BRAVE BRAUZERINIZ ACILDI VE GOOGLE AI PRO REJIMINE QOSULDU!
echo ========================================================================
echo 1. Brave-de sag yuxaridaki profilinizle Google Pro-ya daxil olun.
echo 2. Indi istediyiniz vaxt menu.bat acib videolari hazirlaya bilersiniz.
echo 3. Hesab limiti catanda ekranda bildiris cixacaq, hesabi deyiseceksiniz.
echo.
pause
