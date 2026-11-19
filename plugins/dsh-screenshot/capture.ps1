# DJH screenshot capture helper (English-only comments: PS1 must stay BOM-less safe)
# 1) Declare DPI awareness FIRST: on a 150%-scaled display powershell.exe otherwise
#    reports the virtualized 2560x1440 and CopyFromScreen grabs only the top-left
#    2/3 crop of the real 3840x2160 screen (looks "shrunk/zoomed").
# 2) Capture the whole virtual screen (all monitors) at native resolution.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DjhDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  public const int DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
  public static void Apply() {
    try { SetThreadDpiAwarenessContext((IntPtr)DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch {}
    try { SetProcessDPIAware(); } catch {}
  }
}
'@
[DjhDpi]::Apply()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$out = Join-Path $env:TEMP 'djh-screenshot.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ($out + '|' + $b.Width + 'x' + $b.Height)
