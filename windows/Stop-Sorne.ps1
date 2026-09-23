[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PidFile = Join-Path $Root ".sorne-windows\server.pid"
if (-not (Test-Path $PidFile)) {
    Write-Host "没有找到 Sorne PID 文件；服务可能未运行。" -ForegroundColor Yellow
    exit 0
}

$ServerPid = [int](Get-Content $PidFile -Raw).Trim()
$Process = Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid" -ErrorAction SilentlyContinue
if (-not $Process) {
    Remove-Item $PidFile -Force
    Write-Host "Sorne 已停止。" -ForegroundColor Green
    exit 0
}
if (($Process.CommandLine -notlike "*sorne*") -or ($Process.CommandLine -notlike "*serve*")) {
    throw "PID $ServerPid 不属于 Sorne serve，拒绝终止。"
}

& taskkill /PID $ServerPid /T /F *> $null
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "Sorne 已停止。" -ForegroundColor Green
