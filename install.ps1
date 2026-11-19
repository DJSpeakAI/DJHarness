# DJH plugin kit installer
# - copies plugins into your DSH profile workspace plugins dir
# - creates @local junctions + link deps so DSH loads them
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
param(
    [string]$DshHome = $env:DSH_HOME,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $DshHome)) { Write-Error "DSH_HOME not found at $DshHome - install @deepseek-ai/dsh first"; exit 1 }

$repoRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcPlugins = Join-Path $repoRoot 'plugins'
$profileDir = Join-Path $DshHome 'profiles\web'
$pluginsDir = Join-Path $profileDir 'plugins'
$nmLocal    = Join-Path $profileDir 'node_modules\@local'
$pkgJson    = Join-Path $profileDir 'package.json'

if (-not (Test-Path $pkgJson)) { Write-Error "profile package.json not found: $pkgJson"; exit 1 }

# 1) copy plugins
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
Get-ChildItem $srcPlugins -Directory | ForEach-Object {
    $dest = Join-Path $pluginsDir $_.Name
    if ($Uninstall) { return }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $_.FullName $dest -Recurse -Force
    Write-Host "  copied: $($_.Name)"
}

# 2) junctions in profiles/node_modules/@local
New-Item -ItemType Directory -Force -Path $nmLocal | Out-Null
$names = (Get-ChildItem $srcPlugins -Directory).Name
foreach ($n in $names) {
    $link = Join-Path $nmLocal $n
    $target = Join-Path $pluginsDir $n
    if ($Uninstall) {
        if (Test-Path $link) { (Get-Item $link).Delete() }
        continue
    }
    if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target $target | Out-Null }
}

# 3) package.json link deps (backup once)
$backup = "$pkgJson.bak-djh-install"
if (-not (Test-Path $backup)) { Copy-Item $pkgJson $backup }
$pkg = Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$changed = $false
foreach ($n in $names) {
    $dep = "link:./plugins/$n"
    if ($Uninstall) {
        if ($pkg.dependencies.PSObject.Properties[$n]) { $pkg.dependencies.PSObject.Properties.Remove($n); $changed = $true }
    } elseif (-not $pkg.dependencies.PSObject.Properties[$n]) {
        $pkg.dependencies | Add-Member -NotePropertyName $n -NotePropertyValue $dep
        $changed = $true
    }
}
$json = $pkg | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($pkgJson, $json, (New-Object Text.UTF8Encoding($false)))

if ($Uninstall) { Write-Host "DJH kit uninstalled. Restart DSH to take effect." }
else { Write-Host "DJH kit installed: $($names.Count) plugins. Restart DSH now." }
