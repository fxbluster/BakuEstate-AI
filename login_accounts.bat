@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - 6 Google Accounts Setup (Brave)
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if exist "%PY_EXE%" (
    "%PY_EXE%" "%~dp0scripts\login_interactive.py"
) else (
    python "%~dp0scripts\login_interactive.py"
)
pause
endlocal
