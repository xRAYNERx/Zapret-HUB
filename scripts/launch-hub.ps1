# Zapret HUB launcher: dist\win-unpacked, rebuild when sources are newer.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Exe = Join-Path $Root 'dist\win-unpacked\Zapret HUB.exe'

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

if (Test-ZapretHubRunning) {
    Write-Host ''
    Write-Host 'Zapret HUB уже запущен - закройте его (включая трей) и запустите снова.'
    Write-Host ''
    Read-Host 'Enter - выход'
    exit 1
}

$sourcePaths = @(
    (Join-Path $Root 'electron')
    (Join-Path $Root 'src')
    (Join-Path $Root 'assets')
    (Join-Path $Root 'config.default.json')
    (Join-Path $Root 'package.json')
    (Join-Path $Root 'bundled')
    (Join-Path $Root 'scripts\after-pack-icon.cjs')
    (Join-Path $Root 'scripts\png-to-ico.mjs')
    (Join-Path $Root 'scripts\fetch-bundled.mjs')
)

$sourceTime = Get-MaxWriteTime -Paths $sourcePaths
$exeTime = if (Test-Path $Exe) { (Get-Item $Exe).LastWriteTime } else { [datetime]::MinValue }
$needsBuild = -not (Test-Path $Exe) -or ($sourceTime -gt $exeTime)

if ($needsBuild) {
    Write-Host ''
    Write-Host 'Исходники новее сборки - запускаю npm run build...'
    Write-Host ''
    Push-Location $Root
    try {
        $npm = Get-Command npm.cmd -ErrorAction Stop
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) {
            Write-Host ''
            Write-Host "Сборка завершилась с кодом $LASTEXITCODE"
            Read-Host 'Enter - выход'
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $Exe)) {
    Write-Host ''
    Write-Host "Сборка не найдена: $Exe"
    Write-Host 'Выполните: npm run build'
    Write-Host ''
    Read-Host 'Enter - выход'
    exit 1
}

Start-Process -FilePath $Exe
exit 0