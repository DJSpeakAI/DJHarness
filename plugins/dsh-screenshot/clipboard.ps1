# Put the given PNG file on the Windows clipboard as an image (STA required)
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($Path)
try {
  [System.Windows.Forms.Clipboard]::SetImage($img)
  Write-Output 'ok'
} finally {
  $img.Dispose()
}
