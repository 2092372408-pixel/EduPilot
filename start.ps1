[CmdletBinding()]
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$baseUrl = "http://127.0.0.1:$port"
$stdoutLog = Join-Path $projectRoot 'edu-agent-server.log'
$stderrLog = Join-Path $projectRoot 'edu-agent-server.err.log'
$instanceFile = Join-Path $projectRoot '.edupilot-instance'
if (-not (Test-Path $instanceFile)) {
  try { [IO.File]::WriteAllText($instanceFile, [guid]::NewGuid().ToString(), [Text.Encoding]::ASCII) }
  catch { if (-not (Test-Path $instanceFile)) { throw } }
}
$installationId = (Get-Content -LiteralPath $instanceFile -Raw).Trim()

function Stop-WithMessage([string]$message) {
  Write-Error $message
  exit 1
}

function Test-EduPilotReady {
  try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
    return $response.ok -eq $true -and $response.installationId -eq $installationId
  } catch {
    return $false
  }
}

$bundledNode = Join-Path $projectRoot 'runtime\node.exe'
$nodeCommand = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeCommand) { Stop-WithMessage 'Node.js was not found. Use the Windows installer package or install Node.js 22 LTS.' }

$nodeVersion = (& $nodeCommand --version 2>$null).Trim()
try {
  $nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
} catch {
  Stop-WithMessage "Could not read the Node.js version: $nodeVersion"
}
if ($nodeMajor -lt 22) {
  Stop-WithMessage "EduPilot requires Node.js 22 or newer. Current version: $nodeVersion. Upgrade at https://nodejs.org/"
}

if (Test-EduPilotReady) {
  Write-Host "EduPilot is already running: $baseUrl"
  if (-not $NoBrowser) { Start-Process $baseUrl | Out-Null }
  exit 0
}

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    if (Test-EduPilotReady) {
      Write-Host "EduPilot is already starting: $baseUrl"
      if (-not $NoBrowser) { Start-Process $baseUrl | Out-Null }
      exit 0
    }
    Start-Sleep -Seconds 1
  }
  $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
  Stop-WithMessage "Port $port is used by another installation or program (PID $owners). Close that instance before starting this installation."
}

$envFile = Join-Path $projectRoot '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $projectRoot '.env.example') $envFile
  Write-Host 'Created .env. The app starts in demo mode; configure a real model later in Settings.'
}

$dependencyMarker = Join-Path $projectRoot 'node_modules\better-sqlite3\package.json'
if (-not (Test-Path $dependencyMarker)) {
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npmCommand) {
    Stop-WithMessage 'npm was not found. Reinstall Node.js 22 LTS: https://nodejs.org/'
  }
  Write-Host 'Installing dependencies for the first run...'
  Push-Location $projectRoot
  try {
    & $npmCommand.Source ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Dependency installation failed. Review the npm output and try again.' }
  } finally {
    Pop-Location
  }
}

Push-Location $projectRoot
try {
  $sqliteCheck = (& $nodeCommand -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();" 2>&1 | Out-String).Trim()
  $sqliteExitCode = $LASTEXITCODE
} finally { Pop-Location }
if ($sqliteExitCode -ne 0) {
  Stop-WithMessage "The SQLite native module is not available for this Node.js installation. Install Node.js 22 LTS and run start.bat again.`n$sqliteCheck"
}

Push-Location $projectRoot
try {
  $env:EDUPILOT_INSTANCE_FILE = $instanceFile
  $env:EDUPILOT_DESKTOP = '1'
  $child = Start-Process -FilePath $nodeCommand `
    -ArgumentList @('server/index.js') `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
} finally {
  Pop-Location
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  if ($child.HasExited) { break }
  if (Test-EduPilotReady) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
  $details = if (Test-Path $stderrLog) { (Get-Content $stderrLog -Tail 12) -join "`n" } else { '' }
  if ($details) {
    Stop-WithMessage "EduPilot could not start. Recent error log:`n$details"
  }
  Stop-WithMessage 'EduPilot could not start. Check edu-agent-server.log and edu-agent-server.err.log.'
}

[IO.File]::WriteAllText((Join-Path $projectRoot '.eduowl.pid'), [string]$child.Id, [Text.Encoding]::ASCII)
Write-Host "EduPilot is ready: $baseUrl"
if (-not $NoBrowser) { Start-Process $baseUrl | Out-Null }
