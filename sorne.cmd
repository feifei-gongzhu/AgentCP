@echo off
setlocal
set "ROOT=%~dp0"
set "PYTHON=%ROOT%.venv-windows\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo 尚未安装 Windows 运行环境，请先运行 Install-Sorne.cmd
  exit /b 1
)
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
"%PYTHON%" "%ROOT%sorne" %*
