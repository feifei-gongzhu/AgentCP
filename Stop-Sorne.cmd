@echo off
chcp 65001 >nul
set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PSEXE%" set "PSEXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Stop-Sorne.ps1"
if errorlevel 1 (
    echo.
    echo ============================================
    echo   停止失败，请检查上述错误信息。
    echo ============================================
    pause
    exit /b 1
)
