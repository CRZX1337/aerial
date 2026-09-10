# Aerial icon generator.
#
# Regenerates all PWA/app icons in public/icons from the brand mark
# (gradient rounded square + play glyph, identical to the inline mark in
# index.html and assets/logo.svg). The design lives on a 40-unit grid:
#   rounded rect: x=2, y=2, w=36, h=36, r=11
#   play triangle: (16,12.5) (16,27.5) (29,20)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1
# (Windows only - generated icons are committed, so this is only needed
#  when the brand changes.)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'public\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

# Brand palette (matches --grad in styles.css)
$c1 = [System.Drawing.Color]::FromArgb(139, 92, 246)  # #8b5cf6
$c2 = [System.Drawing.Color]::FromArgb(79, 124, 255)  # #4f7cff
$c3 = [System.Drawing.Color]::FromArgb(45, 212, 255)  # #2dd4ff
$bg = [System.Drawing.Color]::FromArgb(6, 6, 10)      # #06060a

function New-RoundRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
    $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
    $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Save-Icon([int]$size, [string]$file, [double]$markScale, [bool]$fillBg) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        if ($fillBg) { $g.Clear($bg) } else { $g.Clear([System.Drawing.Color]::Transparent) }

        # Mark scaled inside the canvas, optically centered.
        $markSize = [float]($size * $markScale)
        $u = $markSize / 40.0
        $off = [float](($size - $markSize) / 2)

        # Gradient rounded square
        $rectPath = New-RoundRectPath ($off + 2 * $u) ($off + 2 * $u) (36 * $u) (36 * $u) (11 * $u)
        $bounds = New-Object System.Drawing.RectangleF(($off + 2 * $u), ($off + 2 * $u), (36 * $u), (36 * $u))
        $lin = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bounds, $c1, $c3, [float]45)
        $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
        $blend.Colors = @($c1, $c2, $c3)
        $blend.Positions = @(0.0, 0.55, 1.0)
        $lin.InterpolationColors = $blend
        $g.FillPath($lin, $rectPath)

        # Play glyph
        $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
        $pts = @(
            (New-Object System.Drawing.PointF(([float]($off + 16 * $u)), ([float]($off + 12.5 * $u)))),
            (New-Object System.Drawing.PointF(([float]($off + 16 * $u)), ([float]($off + 27.5 * $u)))),
            (New-Object System.Drawing.PointF(([float]($off + 29 * $u)), ([float]($off + 20 * $u))))
        )
        $tri.AddPolygon($pts)
        $g.FillPath([System.Drawing.Brushes]::White, $tri)

        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $g.Dispose()
        $bmp.Dispose()
    }
}

#               size  file                       markScale  darkBg
Save-Icon  32  (Join-Path $outDir 'favicon-32.png')          0.92 $false
Save-Icon 180  (Join-Path $outDir 'apple-touch-icon.png')    0.78 $true
Save-Icon 192  (Join-Path $outDir 'icon-192.png')            0.92 $false
Save-Icon 512  (Join-Path $outDir 'icon-512.png')            0.92 $false
Save-Icon 192  (Join-Path $outDir 'icon-192-maskable.png')   0.62 $true
Save-Icon 512  (Join-Path $outDir 'icon-512-maskable.png')   0.62 $true

Write-Host 'Aerial icons written to public/icons:'
Get-ChildItem $outDir -Filter *.png | ForEach-Object { Write-Host ("  {0}  {1} bytes" -f $_.Name, $_.Length) }
