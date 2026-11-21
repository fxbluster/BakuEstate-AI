@echo off
setlocal
cd /d "%~dp0"
set "PYTHONPATH=%~dp0"
title Baku Estate AI - Interactive Telegram Studio Bot
echo =================================================================
echo   Baku Estate AI - Interactive Telegram Studio Bot
echo   Listening for inline button commands from your phone...
echo =================================================================
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if exist "%PY_EXE%" (
    "%PY_EXE%" -u "%~dp0src\dispatcher\telegram_bot_service.py"
) else (
    python -u "%~dp0src\dispatcher\telegram_bot_service.py"
)
if %ERRORLEVEL% neq 0 pause
endlocal
