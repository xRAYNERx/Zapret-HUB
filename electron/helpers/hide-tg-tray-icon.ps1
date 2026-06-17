param(
    [string]$ExePath = ''
)

$base = 'HKCU:\Control Panel\NotifyIconSettings'
if (-not (Test-Path $base)) { exit 0 }

Get-ChildItem $base | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $props) { return }

    $match = ($props.InitialTooltip -eq 'TG WS Proxy')
    if (-not $match -and $props.ExecutablePath) {
        $match = ($props.ExecutablePath -like '*TgWsProxy*')
        if ($ExePath -and ($props.ExecutablePath -eq $ExePath)) {
            $match = $true
        }
    }

    if ($match) {
        Set-ItemProperty -Path $_.PSPath -Name IsPromoted -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
    }
}