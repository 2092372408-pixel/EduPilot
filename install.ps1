[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repoZip = 'https://github.com/2092372408-pixel/EduPilot/archive/refs/heads/master.zip'
$userRoot = [Environment]::GetFolderPath('UserProfile')
if (-not $InstallDir) { $InstallDir = Join-Path $userRoot 'EduPilot' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$bundleRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$bundleMarker = Join-Path $bundleRoot '.eduowl-bundle'
$browserOptions = @(if ($NoBrowser) { '-NoBrowser' })

function Stop-WithMessage([string]$message) {
  Write-Error $message
  exit 1
}

function Add-Shortcut {
  $desktop = [Environment]::GetFolderPath('DesktopDirectory')
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'EduPilot.lnk'))
  $shortcut.TargetPath = Join-Path $InstallDir 'start.bat'
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Description = 'Start EduPilot and open the browser'
  $icon = Join-Path $InstallDir 'public\EduPilot.ico'
  if (Test-Path $icon) { $shortcut.IconLocation = $icon }
  $shortcut.Save()
  Write-Host "Desktop shortcut created: $desktop\EduPilot.lnk"
}

function Copy-Bundle {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  foreach ($file in @('.eduowl-bundle', '.env.example', 'package.json', 'package-lock.json', 'install.bat', 'install.ps1', 'start.bat', 'start-background.bat', 'start.ps1', 'stop.bat', 'stop.ps1', 'mcp.servers.json', 'README.md', 'README_en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $bundleRoot $file) -Destination $InstallDir -Force
  }
  if (Test-Path (Join-Path $bundleRoot 'release-manifest.json')) {
    Copy-Item -LiteralPath (Join-Path $bundleRoot 'release-manifest.json') -Destination $InstallDir -Force
  }
  foreach ($dir in @('server', 'public', 'node_modules', 'runtime', 'docs')) {
    $source = Join-Path $bundleRoot $dir
    if (Test-Path $source) { Copy-Item -LiteralPath $source -Destination $InstallDir -Recurse -Force }
  }
  foreach ($file in @('kb\books\python-intro\01-变量与数据类型.md', 'kb\books\python-intro\02-流程控制.md', 'kb\chunks\python-intro\chunks.json', 'kb\chunks\python-intro\vectors.json', 'kb\index.json', 'kb\questions.json')) {
    $source = Join-Path (Join-Path $bundleRoot 'data') $file
    if (Test-Path $source) {
      $target = Join-Path (Join-Path $InstallDir 'data') $file
      New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $source -Destination $target -Force
    }
  }
}

$existingProject = Join-Path $InstallDir 'package.json'
if (Test-Path $existingProject) {
  if ((Get-Content $existingProject -Raw -Encoding UTF8 | ConvertFrom-Json).name -ne 'edupilot') { Stop-WithMessage "The install directory contains another project: $InstallDir" }
  if ((Test-Path $bundleMarker) -and $bundleRoot -ne $InstallDir) {
    $port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
      $installedId = Join-Path $InstallDir '.edupilot-instance'
      try {
        if (-not (Test-Path $installedId)) { throw 'No installation identity' }
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
        if ($health.installationId -ne (Get-Content -LiteralPath $installedId -Raw).Trim()) { throw 'Different installation' }
      } catch {
        Stop-WithMessage "Port $port belongs to an older or different installation. Stop it before updating this installation."
      }
      $listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        & taskkill.exe /PID $_ /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Could not stop the installed service before updating.' }
      }
      Start-Sleep -Milliseconds 500
    }
    Copy-Bundle
    Write-Host "Updated EduPilot at $InstallDir (settings and learning data preserved)."
  }
  Add-Shortcut
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'start.ps1') @browserOptions
  exit $LASTEXITCODE
}
if (Test-Path $InstallDir) {
  $hasFiles = Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -First 1
  if ($hasFiles) {
    Stop-WithMessage "The install directory is not empty: $InstallDir. Choose another directory or empty it first."
  }
}

if (Test-Path $bundleMarker) {
  if ($InstallDir -ne $bundleRoot) {
    Copy-Bundle
  }
} else {
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('eduowl-install-' + [guid]::NewGuid().ToString('N'))
  $zipPath = Join-Path $tempRoot 'eduowl.zip'
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  try {
    Write-Host 'Downloading EduPilot...'
    Invoke-WebRequest -UseBasicParsing -Uri $repoZip -OutFile $zipPath
    Expand-Archive -LiteralPath $zipPath -DestinationPath $tempRoot -Force
    $sourceDir = Get-ChildItem -LiteralPath $tempRoot -Directory | Where-Object { $_.Name -like 'EduPilot-*' } | Select-Object -First 1
    if (-not $sourceDir) { Stop-WithMessage 'The downloaded archive did not contain the project directory.' }
    New-Item -ItemType Directory -Path (Split-Path $InstallDir -Parent) -Force | Out-Null
    Move-Item -LiteralPath $sourceDir.FullName -Destination $InstallDir
  } catch {
    Stop-WithMessage "Download or extraction failed: $($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Project installed at: $InstallDir"
Add-Shortcut
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'start.ps1') @browserOptions
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'The project was downloaded, but startup failed. Run start.bat in the install directory for details.' }
