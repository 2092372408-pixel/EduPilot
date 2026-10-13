$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$instanceFile = Join-Path $root '.edupilot-instance'
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if (-not (Test-Path $instanceFile) -or $listeners.Count -eq 0) {
  Write-Host 'EduPilot is not running from this installation.'
  exit 0
}
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
  if ($health.installationId -ne (Get-Content -LiteralPath $instanceFile -Raw).Trim()) { throw 'Different installation' }
} catch {
  Write-Error "Port $port belongs to another installation or cannot be verified; leaving it untouched."
  exit 1
}
$listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
  & taskkill.exe /PID $_ /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the installed service.' }
}
Remove-Item -LiteralPath (Join-Path $root '.eduowl.pid') -ErrorAction SilentlyContinue
Write-Host 'EduPilot stopped.'
