@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - 24/7 Local Render & Scrape Worker
echo =================================================================
echo   Baku Estate AI - Windows Local Worker Daemon
echo   Polls Supabase pipeline_jobs (Scrape / Render / Liveness)
echo =================================================================
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if exist "%PY_EXE%" (
    "%PY_EXE%" "%~dp0src\worker\local_worker.py" %*
) else (
    python "%~dp0src\worker\local_worker.py" %*
)
if "%1"=="" (
    if %ERRORLEVEL% neq 0 pause
)
endlocal
