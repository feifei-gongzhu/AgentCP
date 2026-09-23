[CmdletBinding()]
param(
    [string]$HostAddress = "127.0.0.1",
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Python = Join-Path $Root ".venv-windows\Scripts\python.exe"
$Sorne = Join-Path $Root "sorne"
$Runtime = Join-Path $Root ".sorne-windows"
$PidFile = Join-Path $Runtime "server.pid"
$Stdout = Join-Path $Runtime "server.out.log"
$Stderr = Join-Path $Runtime "server.err.log"
$Url = "http://${HostAddress}:$Port/frontend/"
$Api = "http://${HostAddress}:$Port/api/projects"

if (-not (Test-Path $Python)) {
    throw "尚未安装 Windows 运行环境。请先双击 Install-Sorne.cmd。"
}
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

try {
    $existing = Invoke-RestMethod -Uri $Api -TimeoutSec 2
    if ($existing.ok) {
        Write-Host "Sorne 已在运行：$Url" -ForegroundColor Green
        if (-not $NoBrowser) { Start-Process $Url }
        exit 0
    }
} catch {}

$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$argumentLine = ('"{0}" serve --host {1} --port {2}' -f $Sorne, $HostAddress, $Port)
$Process = Start-Process `
    -FilePath $Python `
    -ArgumentList $argumentLine `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $Stdout `
    -RedirectStandardError $Stderr `
    -WindowStyle Hidden `
    -PassThru
Set-Content -Path $PidFile -Value $Process.Id -Encoding ASCII

$ready = $false
for ($index = 0; $index -lt 30; $index++) {
    Start-Sleep -Milliseconds 500
    if ($Process.HasExited) { break }
    try {
        $response = Invoke-RestMethod -Uri $Api -TimeoutSec 2
        if ($response.ok) { $ready = $true; break }
    } catch {}
}

if (-not $ready) {
    $tail = if (Test-Path $Stderr) { (Get-Content $Stderr -Tail 30) -join "`n" } else { "无错误日志" }
    throw "Sorne 未能在 15 秒内启动。`n$tail"
}

Write-Host "Sorne 已启动：$Url" -ForegroundColor Green
Write-Host "PID: $($Process.Id)  日志: $Runtime" -ForegroundColor DarkGray
if (-not $NoBrowser) { Start-Process $Url }
