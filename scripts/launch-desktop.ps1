# Starts the installed Robo Buddy on the interactive desktop (WinSta0\Default).
# Usage (from the repo root):  pwsh scripts/launch-desktop.ps1
# Start-Process puts a child wherever its parent already is, so launching the app from a session
# that is not the interactive one runs it where nobody can see it, which looks exactly like a
# crash. CreateProcess takes the desktop as an argument, which is the only way to say where the
# app should appear. Pair it with check-process.ps1 when a launch seems to do nothing.
# The path below is this machine's per-user install; change it if yours is elsewhere.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ProcessLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public Int32 cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public Int32 dwX;
        public Int32 dwY;
        public Int32 dwXSize;
        public Int32 dwYSize;
        public Int32 dwXCountChars;
        public Int32 dwYCountChars;
        public Int32 dwFillAttribute;
        public Int32 dwFlags;
        public Int16 wShowWindow;
        public Int16 cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public Int32 dwProcessId;
        public Int32 dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        ref PROCESS_INFORMATION lpProcessInformation
    );
}
'@

$si = New-Object ProcessLauncher+STARTUPINFO
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpDesktop = "WinSta0\Default"

$pi = New-Object ProcessLauncher+PROCESS_INFORMATION

$exePath = "C:\Users\Occor\AppData\Local\Robo Buddy\robo-buddy.exe"
$workDir = "C:\Users\Occor\AppData\Local\Robo Buddy"

$res = [ProcessLauncher]::CreateProcessW(
    $exePath,
    $null,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    $false,
    0,
    [IntPtr]::Zero,
    $workDir,
    [ref]$si,
    [ref]$pi
)

if ($res) {
    Write-Host "Started robo-buddy with PID: $($pi.dwProcessId)"
} else {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "CreateProcess failed with error: $err"
}
