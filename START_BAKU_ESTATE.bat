@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - 1-Click Autonomous Video Engine
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if not exist "%PY_EXE%" (
    set "PY_EXE=python"
)

echo ========================================================================
echo       BAKU ESTATE AI - BIRBASA ISE SALMA (1-CLICK RUNNER)
echo ========================================================================
echo.
echo  * Brave avtomatik acilir (Google Pro hesabin yuklenir)
echo  * bina.az-dan sahibinden kupcali menziller tapilir
echo  * Google Pro (Gemini) en baximli Reels ssenarisini yazir
echo  * OpenAI Nova HD xanim sesi ve Luxury Lounge fon musiqisi ile montaj olunur
echo  * Telegram-a gonderilir (@bakuestatee_bot)
echo  * Hesab kvotasi bitende ekranda sesli bildiris cixir:
echo    "Brave-de novbeti Google Pro hesabina kec ve [OK] bas"
echo ========================================================================
echo.

set /p VID_COUNT="Nece eded video hazirlansin? (Enter = 3): "
if "%VID_COUNT%"=="" set VID_COUNT=3

echo.
echo [BASLADI] %VID_COUNT% eded video hazirlanir...
"%PY_EXE%" run_pipeline.py --use-gemini --live-dispatch --limit %VID_COUNT%

echo.
echo ========================================================================
echo   PARTIYA TAMAMLANDI!
echo ========================================================================
pause
