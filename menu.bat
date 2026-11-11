@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - Interactive Control Center
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if exist "%PY_EXE%" (
    "%PY_EXE%" "%~dp0interactive_menu.py" %*
) else (
    python "%~dp0interactive_menu.py" %*
)
if "%1"=="" (
    if %ERRORLEVEL% neq 0 pause
)
endlocal
