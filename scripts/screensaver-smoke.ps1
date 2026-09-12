param([int]$Seconds = 60)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ScreensaverProbe {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc fn, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int n);
  public static string Title() {
    string result = "";
    EnumWindows((h,p) => { var b = new StringBuilder(4096); GetWindowText(h,b,b.Capacity); if(b.ToString().StartsWith("Robo Buddy |")) result=b.ToString(); return true; }, IntPtr.Zero);
    return result;
  }
}
"@
$until = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $until) {
  $title = [ScreensaverProbe]::Title()
  [pscustomobject]@{ at=(Get-Date).ToString('o'); title=$title } | ConvertTo-Json -Compress
  Start-Sleep -Seconds 1
}
