[CmdletBinding()]
param(
    [switch]$SkipBrowser,
    [switch]$SkipDockerCheck
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Venv = Join-Path $Root ".venv-windows"
$Python = Join-Path $Venv "Scripts\python.exe"

function Invoke-SystemPython {
    param([string[]]$Arguments)
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 @Arguments
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        & python @Arguments
    } else {
        throw "未找到 Python。请先安装 Python 3.11 或 3.12 x64，并勾选 Add Python to PATH。"
    }
    if ($LASTEXITCODE -ne 0) { throw "Python 命令执行失败，退出码 $LASTEXITCODE" }
}

Write-Host "[1/5] 检查 Python..." -ForegroundColor Cyan
Invoke-SystemPython -Arguments @("-c", "import sys; assert sys.version_info >= (3,10), sys.version; print(sys.version)")

if (-not (Test-Path $Python)) {
    Write-Host "[2/5] 创建 Windows 虚拟环境..." -ForegroundColor Cyan
    Invoke-SystemPython -Arguments @("-m", "venv", $Venv)
} else {
    Write-Host "[2/5] 复用现有虚拟环境。" -ForegroundColor DarkGray
}

Write-Host "[3/5] 安装 AgentCP 运行依赖..." -ForegroundColor Cyan
& $Python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip 升级失败" }
& $Python -m pip install -r (Join-Path $PSScriptRoot "requirements-windows.txt")
if ($LASTEXITCODE -ne 0) { throw "Windows 依赖安装失败" }

if (-not $SkipBrowser) {
    Write-Host "[4/5] 安装 mrecon 使用的 Chromium..." -ForegroundColor Cyan
    & $Python -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Playwright Chromium 安装失败" }
} else {
    Write-Host "[4/5] 已跳过 Chromium 安装。" -ForegroundColor DarkGray
}

Write-Host "[5/5] 检查 Docker Desktop..." -ForegroundColor Cyan
if (-not $SkipDockerCheck) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Warning "未找到 Docker CLI。Web 控制台可以启动，但默认 local-docker Worker 需要安装并启动 Docker Desktop (WSL2 backend)。"
    } else {
        & docker info *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Docker CLI 已安装，但 Docker Desktop 尚未启动。"
        } else {
            Write-Host "Docker Desktop 可用。" -ForegroundColor Green
        }
    }
}

Write-Host "安装完成。双击 Start-AgentCP.cmd 启动系统。" -ForegroundColor Green
