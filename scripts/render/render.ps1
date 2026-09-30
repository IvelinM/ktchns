<#
.SYNOPSIS
    Photoreal render of a WebCAD .glb via Blender + Cycles (Windows wrapper).

.DESCRIPTION
    Locates blender.exe (PATH, then the usual install folders) and runs render_kitchen.py.
    Export the .glb from /admin ▸ Visualisation ▸ "Export for render (.glb)" first.

.EXAMPLE
    ./render.ps1 kitchen-render.glb
    ./render.ps1 kitchen-render.glb out.png -Samples 512 -Width 2400 -Hdri studio
#>
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Glb,
    [Parameter(Position = 1)][string]$Out,
    [int]$Samples = 256,
    [int]$Width = 1600,
    [ValidateSet('interior', 'studio', 'courtyard', 'city', 'forest', 'night', 'sunrise', 'sunset')]
    [string]$Hdri = 'interior',
    [ValidateSet('cycles', 'eevee')][string]$Engine = 'cycles'
)

$ErrorActionPreference = 'Stop'

# --- locate blender.exe ---
$blender = (Get-Command blender -ErrorAction SilentlyContinue).Source
if (-not $blender) {
    $roots = @(
        (Join-Path $env:ProgramFiles 'Blender Foundation'),
        (Join-Path ${env:ProgramFiles(x86)} 'Blender Foundation'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Blender Foundation')
    )
    foreach ($r in $roots) {
        if (Test-Path $r) {
            $hit = Get-ChildItem $r -Recurse -Filter blender.exe -ErrorAction SilentlyContinue |
                Sort-Object FullName -Descending | Select-Object -First 1
            if ($hit) { $blender = $hit.FullName; break }
        }
    }
}
if (-not $blender) {
    Write-Error "blender.exe not found. Install Blender (free) from https://www.blender.org/download/ or add it to PATH."
    exit 1
}
Write-Host "Blender: $blender"

if (-not (Test-Path $Glb)) { Write-Error "GLB not found: $Glb"; exit 1 }
$script = Join-Path $PSScriptRoot 'render_kitchen.py'

# --- assemble Blender args (script args go after the bare '--') ---
$blenderArgs = @('-b', '--python', $script, '--', (Resolve-Path $Glb).Path)
if ($Out) { $blenderArgs += $Out }
$blenderArgs += @('--samples', $Samples, '--width', $Width, '--hdri', $Hdri, '--engine', $Engine)

& $blender @blenderArgs
