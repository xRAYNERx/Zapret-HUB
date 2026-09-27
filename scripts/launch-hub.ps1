# Zapret HUB launcher: dist\win-unpacked, rebuild when sources are newer.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Exe = Join-Path $Root 'dist\win-unpacked\Zapret HUB.exe'
$Asar = Join-Path $Root 'dist\win-unpacked\resources\app.asar'

function Get-MaxWriteTime {
    param([string[]]$Paths)
    $max = [datetime]::MinValue
    foreach ($p in $Paths) {
        if (-not (Test-Path $p)) { continue }
        $item = Get-Item $p
        if ($item.PSIsContainer) {
            Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.LastWriteTime -gt $max) { $max = $_.LastWriteTime }
            }
        } elseif ($item.LastWriteTime -gt $max) {
            $max = $item.LastWriteTime
        }
    }
    return $max
}

function Test-ZapretHubRunning {
    $p = Get-Process -Name 'Zapret HUB' -ErrorAction SilentlyContinue
    return [bool]$p
}

$sourcePaths = @(
    (Join-Path $Root 'electron')
    (Join-Path $Root 'src')
    (Join-Path $Root 'assets')
    (Join-Path $Root 'config.default.json')
    (Join-Path $Root 'package.json')
    (Join-Path $Root 'bundled')
)

$builtTime = if (Test-Path $Asar) { (Get-Item $Asar).LastWriteTime } elseif (Test-Path $Exe) { (Get-Item $Exe).LastWriteTime } else { [datetime]::MinValue }
$sourceTime = Get-MaxWriteTime -Paths $sourcePaths
$needsBuild = -not (Test-Path $Exe) -or ($sourceTime -gt $builtTime)

if (Test-ZapretHubRunning) {
    Write-Host 'Closing previous Zapret HUB instance...'
    Stop-Process -Name 'Zapret HUB' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
}

if ($needsBuild) {
    Write-Host ''
    Write-Host 'Updating files - fast rebuild (2 sec)...'
    Write-Host ''
    Push-Location $Root
    try {
        $npm = Get-Command npm.cmd -ErrorAction Stop
        & $npm.Source run build:fast
        if ($LASTEXITCODE -ne 0) {
            Write-Host ''
            Write-Host 'Build failed'
            Read-Host 'Press Enter to exit'
            exit $LASTEXITCODE
        }
        if (Test-Path $Exe) {
            (Get-Item $Exe).LastWriteTime = (Get-Date).AddSeconds(5)
        }
        if (Test-Path $Asar) {
            (Get-Item $Asar).LastWriteTime = (Get-Date).AddSeconds(5)
        }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $Exe)) {
    Write-Host ''
    Write-Host 'Executable not found:' $Exe
    Write-Host 'Please run: npm run build:fast'
    Write-Host ''
    Read-Host 'Press Enter to exit'
    exit 1
}

Write-Host 'Launching Zapret HUB...'
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe)
exit 0