@echo off
setlocal
cd /d "%~dp0"
title Baku Estate AI - Google AI Pro MCP Server
set "PY_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
if not exist "%PY_EXE%" (
    set "PY_EXE=python"
)

"%PY_EXE%" "%~dp0src\mcp_server.py" %*
