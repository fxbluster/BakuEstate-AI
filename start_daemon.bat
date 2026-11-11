@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - Background Daemon
echo =================================================================
echo   Baku Estate AI - Autonomous Scheduler Daemon
echo   Automated Social Media Video Production Service
echo =================================================================
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if exist "%PY_EXE%" (
    "%PY_EXE%" "%~dp0src\scheduler.py" %*
) else (
    python "%~dp0src\scheduler.py" %*
)
if "%1"=="" (
    if %ERRORLEVEL% neq 0 pause
)
endlocal
