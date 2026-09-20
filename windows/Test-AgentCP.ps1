[CmdletBinding()]
param()

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Python = Join-Path $Root ".venv-windows\Scripts\python.exe"
$failed = $false

function Report([string]$Name, [bool]$Ok, [string]$Detail) {
    $color = if ($Ok) { "Green" } else { "Yellow" }
    Write-Host ("{0,-22} {1,-8} {2}" -f $Name, $(if ($Ok) { "OK" } else { "WARN" }), $Detail) -ForegroundColor $color
}

$pythonOk = Test-Path $Python
Report "Python virtualenv" $pythonOk $Python
if ($pythonOk) {
    & $Python -c "import keyring, playwright; import src.agent_control_plane.webapp; print('imports ok')"
    $importsOk = $LASTEXITCODE -eq 0
    Report "Python imports" $importsOk "keyring / playwright / AgentCP"
    if (-not $importsOk) { $failed = $true }
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
Report "Docker CLI" ($null -ne $docker) $(if ($docker) { $docker.Source } else { "请安装 Docker Desktop" })
if ($docker) {
    & docker info *> $null
    Report "Docker daemon" ($LASTEXITCODE -eq 0) "Docker Desktop / WSL2"
}

try {
    $api = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/projects" -TimeoutSec 2
    Report "AgentCP server" ([bool]$api.ok) "http://127.0.0.1:8765/frontend/"
} catch {
    Report "AgentCP server" $false "尚未启动"
}

if ($failed) { exit 1 }
