# Lists every window robo-buddy has open, visible or not.
# Usage (from the repo root):  pwsh scripts/check-process.ps1
# For when the app is running but nothing is on screen: screensaver windows left covering a
# monitor after a botched teardown, or a window that went up somewhere you cannot see it. Walks
# the interactive desktop rather than the process's own window list, so a window that exists but
# is hidden is still reported, with its PID, handle, visibility and title.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@

$pids = Get-Process -Name robo-buddy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id
Write-Host "Running robo-buddy PIDs: $($pids -join ', ')"

$hDesk = [WinEnum]::OpenDesktop("Default", 0, $false, 0x0100) # DESKTOP_ENUMERATE
if ($hDesk -eq [IntPtr]::Zero) {
    Write-Host "Could not open WinSta0\Default desktop directly (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
} else {
    try {
        [WinEnum]::EnumDesktopWindows($hDesk, {
            param($hwnd, $lparam)
            $wpid = 0
            [WinEnum]::GetWindowThreadProcessId($hwnd, [ref]$wpid) | Out-Null
            if ($pids -contains $wpid) {
                $sb = New-Object System.Text.StringBuilder 512
                [WinEnum]::GetWindowText($hwnd, $sb, 512) | Out-Null
                $vis = [WinEnum]::IsWindowVisible($hwnd)
                Write-Host "PID: $wpid | HWND: 0x$($hwnd.ToString('X')) | Vis: $vis | Title: '$($sb.ToString())'"
            }
            return $true
        }, [IntPtr]::Zero) | Out-Null
    } finally {
        [WinEnum]::CloseDesktop($hDesk) | Out-Null
    }
}
