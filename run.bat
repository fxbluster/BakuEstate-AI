@echo off
setlocal
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if exist "%PY_EXE%" (
    "%PY_EXE%" "%~dp0run_pipeline.py" %*
) else (
    python "%~dp0run_pipeline.py" %*
)
endlocal
