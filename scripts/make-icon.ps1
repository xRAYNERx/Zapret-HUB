param(
    [string]$Source = "C:\Users\RAYNER\.grok\sessions\C%3A%5CUsers%5CRAYNER%5C.grok%5Cclients%5Czapret\019ecae2-a24d-7a93-8ba4-4d1904913270\images\1.jpg",
    [string]$PreviewOut = "D:\PROGRAMMS\Zapret NEW\assets\icon-preview.png",
    [string]$IconOut = "D:\PROGRAMMS\Zapret NEW\assets\icon.png",
    [switch]$Apply
)

Add-Type -AssemblyName System.Drawing

function ColorDist([int]$r, [int]$g, [int]$b, [int]$r2, [int]$g2, [int]$b2) {
    [Math]::Sqrt(($r - $r2) * ($r - $r2) + ($g - $g2) * ($g - $g2) + ($b - $b2) * ($b - $b2))
}

function IsBackground([int]$r, [int]$g, [int]$b) {
    $lum = 0.299 * $r + 0.587 * $g + 0.114 * $b
    if ($lum -gt 95) { return $false }
    $d1 = ColorDist $r $g $b 19 34 55
    $d2 = ColorDist $r $g $b 20 35 54
    return ($d1 -lt 28 -or $d2 -lt 28) -and $lum -lt 80
}

function IsLockPixel([int]$x, [int]$y, [int]$r, [int]$g, [int]$b) {
    if ($x -lt 395 -or $x -gt 555 -or $y -lt 375 -or $y -gt 565) { return $false }
    $lum = 0.299 * $r + 0.587 * $g + 0.114 * $b
    if ($lum -gt 70) { return $false }
    if ($r -gt 35 -or $g -gt 55 -or $b -gt 80) { return $false }
    if ($g -gt 140) { return $false }
    return $true
}

$srcBmp = [System.Drawing.Bitmap]::FromFile($Source)
$w = $srcBmp.Width
$h = $srcBmp.Height
$out = New-Object System.Drawing.Bitmap $w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb

$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$srcData = $srcBmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $srcBmp.PixelFormat)
$dstData = $out.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $out.PixelFormat)

$bytesPerPixel = [System.Drawing.Image]::GetPixelFormatSize($srcBmp.PixelFormat) / 8
$srcStride = $srcData.Stride
$dstStride = $dstData.Stride
$srcPtr = $srcData.Scan0
$dstPtr = $dstData.Scan0
$srcBytes = New-Object byte[] ($srcStride * $h)
$dstBytes = New-Object byte[] ($dstStride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($srcPtr, $srcBytes, 0, $srcBytes.Length)

for ($y = 0; $y -lt $h; $y++) {
    $srcRow = $y * $srcStride
    $dstRow = $y * $dstStride
    for ($x = 0; $x -lt $w; $x++) {
        $i = $srcRow + $x * $bytesPerPixel
        $b = $srcBytes[$i]
        $g = $srcBytes[$i + 1]
        $r = $srcBytes[$i + 2]
        $a = $srcBytes[$i + 3]

        if (IsBackground $r $g $b) {
            $nr = 0; $ng = 0; $nb = 0
        }
        elseif (IsLockPixel $x $y $r $g $b) {
            $nr = 34; $ng = 197; $nb = 94
        }
        else {
            $nr = $r; $ng = $g; $nb = $b
        }

        $oi = $dstRow + $x * 4
        $dstBytes[$oi] = $nb
        $dstBytes[$oi + 1] = $ng
        $dstBytes[$oi + 2] = $nr
        $dstBytes[$oi + 3] = $a
    }
}

[System.Runtime.InteropServices.Marshal]::Copy($dstBytes, 0, $dstPtr, $dstBytes.Length)
$srcBmp.UnlockBits($srcData)
$out.UnlockBits($dstData)

$previewDir = Split-Path $PreviewOut -Parent
if (-not (Test-Path $previewDir)) { New-Item -ItemType Directory -Path $previewDir -Force | Out-Null }
$out.Save($PreviewOut, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Preview saved: $PreviewOut"

if ($Apply) {
    $out.Save($IconOut, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Icon applied: $IconOut"
}

$srcBmp.Dispose()
$out.Dispose()