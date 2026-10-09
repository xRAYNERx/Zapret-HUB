# Zapret.NET launcher: dist\win-unpacked, rebuild when sources are newer.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
function Get-ZapretExe {
    $n = Join-Path $Root 'dist\win-unpacked\Zapret.NET.exe'
    $p = Join-Path $Root 'dist\win-unpacked\Zapret.NET.exe'
    $h = Join-Path $Root 'dist\win-unpacked\Zapret HUB.exe'
    if (Test-Path $n) { return $n }
    if (Test-Path $p) { return $p }
    if (Test-Path $h) { return $h }
    return $n
}

$Exe = Get-ZapretExe
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

function Stop-AllAppProcesses {
    $procNames = @(
        'Zapret.NET',
        'Zapret.NET',
        'Zapret HUB',
        'ZapretTgProxy',
        'electron',
        'winws',
        'xray',
        'sing-box'
    )
    $found = $false
    foreach ($name in $procNames) {
        $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
        if ($procs) {
            $found = $true
            $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }
    if ($found) {
        Write-Host 'Closing previous Zapret.NET and background processes...'
        Start-Sleep -Milliseconds 800
    }
    $lockDir = Join-Path $env:APPDATA 'TgWsProxy'
    if (Test-Path $lockDir) {
        Get-ChildItem -Path $lockDir -Filter '*.lock' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }
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

Stop-AllAppProcesses

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
        $Exe = Get-ZapretExe
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

$Exe = Get-ZapretExe

if (-not (Test-Path $Exe)) {
    Write-Host ''
    Write-Host 'Executable not found:' $Exe
    Write-Host 'Please run: npm run build:fast'
    Write-Host ''
    Read-Host 'Press Enter to exit'
    exit 1
}

Write-Host 'Launching Zapret.NET...'
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe)
exit 0