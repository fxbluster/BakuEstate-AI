@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - 24/7 Local Worker Watchdog Supervisor
echo =================================================================
echo   Baku Estate AI - Windows Local Worker Watchdog Supervisor
echo   Polls Supabase pipeline_jobs (Autonomous Recovery & Supervision)
echo =================================================================
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if exist "%PY_EXE%" (
    "%PY_EXE%" "%~dp0src\worker\watchdog.py" %*
) else (
    python "%~dp0src\worker\watchdog.py" %*
)
if "%1"=="" (
    if %ERRORLEVEL% neq 0 pause
)
endlocal
